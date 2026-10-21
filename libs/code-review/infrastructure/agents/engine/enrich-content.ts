/**
 * Enrichment, model half (#1821): the title and the fix of a lean finding.
 * Two ways to run it, measured against each other in evals/enrichment:
 *  - one call (LLM.run) over the cited code, a numbered window of the file
 *    and its diff;
 *  - an agent loop with the finder's read tools over the PR head, for fixes
 *    that depend on code outside that window.
 * Severity is a separate step.
 */
import { z } from 'zod';

import type {
    AgentRunner,
    AgentSpec,
} from '@libs/agent-harness/domain/contracts/agent.contract';
import type { JSONSchema } from '@libs/agent-harness/domain/contracts/json-schema.contract';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import type {
    ToolContext,
    ToolRegistry,
} from '@libs/agent-harness/domain/contracts/tool.contract';
import { BudgetPolicy } from '@libs/agent-harness/infrastructure/policies/budget.policy';
import { ForceFinalizePolicy } from '@libs/agent-harness/infrastructure/policies/force-finalize.policy';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import { TITLE_PROMPT_SPEC } from '@libs/common/utils/codeManagement/suggestion-title';
import type { LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';
import { LLM } from '@libs/llm/llm';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { extractLastJsonObjectWith } from '@libs/llm/structured-output-repair';

export const ENRICH_DONE_TOOL = 'submitEnrichment' as const;

export const FIX_STATUSES = [
    'local',
    'needs-wider-change',
    'insufficient-context',
    'no-code-fix',
] as const;
export type FixStatus = (typeof FIX_STATUSES)[number];

export type ContentEnrichment = {
    oneSentenceSummary: string;
    fixStatus: FixStatus;
    /** Replacement for exactly the cited lines; '' with `local` = delete them. */
    improvedCode: string;
};

export type EnrichmentInput = {
    finding: {
        label?: string;
        relevantFile?: string;
        relevantLinesStart?: number;
        relevantLinesEnd?: number;
        suggestionContent?: string;
    };
    existingCode: string;
    language: string;
    /** Numbered lines of the head file around the cited range. */
    fileWindow: string;
    filePatch: string;
};

const RESULT_SCHEMA: JSONSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        title: { type: 'string' },
        fixStatus: { type: 'string', enum: [...FIX_STATUSES] },
        improvedCode: { type: 'string' },
    },
    required: ['title', 'fixStatus', 'improvedCode'],
};

const RESULT_ZOD = z.object({
    title: z.string(),
    fixStatus: z.enum(FIX_STATUSES),
    improvedCode: z.string(),
});

const TASK = `You complete a code-review finding so it can be posted as a comment. The finding is a confirmed defect in a pull request; you receive its text, the file and the cited lines, the cited code, a numbered window of the file at the pull request head, and the file's diff.

Return:
- title: ${TITLE_PROMPT_SPEC}.
- fixStatus and improvedCode:
  - "local": improvedCode is the full replacement for EXACTLY the cited lines (relevantLinesStart..relevantLinesEnd), with the file's indentation, so that putting it in place of those lines fixes the defect. No line numbers, no diff markers, no markdown fence. An empty improvedCode means "delete the cited lines".
  - "needs-wider-change": a correct fix must also change code outside the cited lines.
  - "insufficient-context": you cannot write a correct fix without guessing names, signatures or behavior you have not seen.
  - "no-code-fix": the problem is not fixed by changing code.
  For every status other than "local", improvedCode is "".
Write a fix whenever you can write a correct one. Do not abstain to be safe, and do not guess.`;

const WITH_TOOLS = `

You can read the repository at the pull request head with the read tools. Use them only to confirm the names, signatures and behavior the fix depends on; a few reads are enough. Then call ${ENRICH_DONE_TOOL} with title, fixStatus and improvedCode.`;

const ONE_SHOT = `

Return only the JSON object {"title", "fixStatus", "improvedCode"}.`;

export function buildEnrichmentPrompt(
    input: EnrichmentInput,
    withTools: boolean,
): { system: string; user: string } {
    const f = input.finding;
    const user = [
        `<Finding>`,
        `label: ${f.label ?? ''}`,
        `file: ${f.relevantFile ?? ''}`,
        `cited lines: ${f.relevantLinesStart ?? '?'}-${f.relevantLinesEnd ?? f.relevantLinesStart ?? '?'}`,
        `text: ${f.suggestionContent ?? ''}`,
        `</Finding>`,
        ``,
        `<CitedCode language="${input.language}">`,
        input.existingCode || '(not available)',
        `</CitedCode>`,
        ``,
        `<FileWindow>`,
        input.fileWindow || '(not available)',
        `</FileWindow>`,
        ``,
        `<FileDiff>`,
        input.filePatch || '(not available)',
        `</FileDiff>`,
    ].join('\n');
    return { system: TASK + (withTools ? WITH_TOOLS : ONE_SHOT), user };
}

/** Normalizes a model answer; null when it is not one. */
export function parseEnrichment(raw: unknown): ContentEnrichment | null {
    const r = RESULT_ZOD.safeParse(raw);
    if (!r.success) return null;
    const local = r.data.fixStatus === 'local';
    return {
        oneSentenceSummary: r.data.title.trim(),
        fixStatus: r.data.fixStatus,
        improvedCode: local ? stripFence(r.data.improvedCode) : '',
    };
}

function stripFence(code: string): string {
    const m = /^```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(code.trim());
    return m ? m[1] : code;
}

export async function enrichOneShot(
    input: EnrichmentInput,
    opts: {
        byokConfig?: NormalizedModel;
        prebuiltModel?: unknown;
        telemetryMetadata?: LangfuseTelemetryMetadata;
        runName?: string;
    } = {},
): Promise<ContentEnrichment | null> {
    const { system, user } = buildEnrichmentPrompt(input, false);
    const out = await LLM.run({
        system,
        user,
        schema: RESULT_ZOD,
        byokConfig: opts.byokConfig,
        prebuiltModel: opts.prebuiltModel as any,
        telemetryMetadata: opts.telemetryMetadata,
        runName: opts.runName ?? 'code-review-enrich',
    } as any);
    return parseEnrichment(out);
}

export function buildEnricherAgentSpec(params: {
    tools: ToolRegistry;
    maxSteps?: number;
    providerOptions?: Readonly<Record<string, unknown>>;
    runName?: string;
}): AgentSpec {
    const tools = new InMemoryToolRegistry([
        ...params.tools.list(),
        {
            name: ENRICH_DONE_TOOL,
            description:
                'Submit the title, fixStatus and improvedCode of the finding and end.',
            inputSchema: RESULT_SCHEMA,
            execute: async () => ({ output: 'submitted' }),
        },
    ]);
    return {
        id: 'enricher',
        runName: params.runName ?? 'code-review-enrich',
        phase: 'enrich',
        systemPrompt: TASK + WITH_TOOLS,
        tools,
        policies: [
            new BudgetPolicy(),
            new ForceFinalizePolicy({ doneToolName: ENRICH_DONE_TOOL }),
        ],
        maxSteps: params.maxSteps ?? 6,
        resultToolName: ENRICH_DONE_TOOL,
        providerOptions: params.providerOptions,
    } as AgentSpec;
}

/** The submitted payload, else the last JSON object in the final text. */
export function enrichmentFromRun(state: RunState): ContentEnrichment | null {
    for (let i = state.artifacts.length - 1; i >= 0; i--) {
        const a = state.artifacts[i];
        if (a.type !== ENRICH_DONE_TOOL) continue;
        const parsed = parseEnrichment(a.payload);
        if (parsed) return parsed;
    }
    const text = state.steps[state.steps.length - 1]?.message.content;
    const json =
        typeof text === 'string' && text.trim()
            ? extractLastJsonObjectWith(text, ['fixStatus'])
            : null;
    return json ? parseEnrichment(json) : null;
}

export async function enrichWithTools(
    input: EnrichmentInput,
    deps: {
        runner: AgentRunner;
        tools: ToolRegistry;
        ctx: ToolContext;
        maxSteps?: number;
        providerOptions?: Readonly<Record<string, unknown>>;
    },
): Promise<{ result: ContentEnrichment | null; state: RunState }> {
    const spec = buildEnricherAgentSpec({
        tools: deps.tools,
        maxSteps: deps.maxSteps,
        providerOptions: deps.providerOptions,
    });
    const { user } = buildEnrichmentPrompt(input, true);
    const state = await deps.runner.run(spec, { prompt: user }, deps.ctx);
    return { result: enrichmentFromRun(state), state };
}
