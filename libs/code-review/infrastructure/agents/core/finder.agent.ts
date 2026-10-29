/**
 * code-review (domain) — Finder agent assembled on agent-harness.
 *
 * Step 1+2 of the strangler: compose the real finder as an AgentSpec over the
 * new runner (prompt + tool registry + the 3 prepareStep policies + coverage
 * gate), and extract the structured findings from the RunState.
 *
 * This is pure composition of already-tested primitives — no new loop, no new
 * concern. It runs ALONGSIDE the legacy agent (behind a flag, next step); the
 * legacy path is untouched.
 */
import type { LanguageModel } from 'ai';
import type {
    AgentRunner,
    AgentSpec,
} from '@libs/agent-harness/domain/contracts/agent.contract';
import type { Compressor } from '@libs/agent-harness/domain/contracts/compression.contract';
import type { ProgressLedger } from '@libs/agent-harness/domain/contracts/progress.contract';
import type { JSONSchema } from '@libs/agent-harness/domain/contracts/json-schema.contract';
import type {
    RunState,
    TokenUsage,
} from '@libs/agent-harness/domain/contracts/run-state.contract';
import type {
    AgentTool,
    ToolContext,
    ToolRegistry,
} from '@libs/agent-harness/domain/contracts/tool.contract';
import { runVerificationPass } from '@libs/agent-harness/infrastructure/orchestration/verification-pass';
import { BudgetPolicy } from '@libs/agent-harness/infrastructure/policies/budget.policy';
import { CompressionPolicy } from '@libs/agent-harness/infrastructure/policies/compression.policy';
import { CompletionGatePolicy } from '@libs/agent-harness/infrastructure/policies/completion-gate.policy';
import { ForceFinalizePolicy } from '@libs/agent-harness/infrastructure/policies/force-finalize.policy';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import { LlmVerifier } from '@libs/code-review/infrastructure/agents/core/verifier.agent';
import { ConventionVerifier } from '@libs/code-review/infrastructure/agents/core/convention-verifier.agent';
import {
    checkConventionQuotes,
    isToolSource,
    isProvenByAstGrep,
    type AstGrepOutputLog,
    type ConventionCheckRejected,
    type GuideDirLister,
    type GuideFileReader,
} from '@libs/code-review/infrastructure/agents/core/convention-check';
import { buildToolEvidenceSummary } from '@libs/code-review/infrastructure/agents/core/agent-anomalies';
import { supportsStrictToolsForRun } from '@libs/code-review/infrastructure/agents/core/model-strictness';
import type { ToolEvidenceSummary } from '@libs/code-review/infrastructure/agents/review-agent.contract';
import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import {
    citesRepoInstruction,
    isRepoInstructionFile,
    quotesRepoInstruction,
    type RepoInstructionsContext,
} from '@libs/code-review/infrastructure/agents/collaborators/repo-instructions';
import { formatPreviousDecisions } from '@libs/code-review/infrastructure/agents/prompts/prompt-builder';
import type {
    Verdict,
    VerdictParseMode,
} from '@libs/agent-harness/domain/contracts/verifier.contract';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
    type LangfuseTelemetryMetadata,
} from '@libs/core/log/langfuse';
// Domain helper relocated out of the legacy file (Zod validation of findings).
import { sanitizeFindingsResult } from '@libs/code-review/infrastructure/agents/core/findings-schema';
import { LLM } from '@libs/llm/llm';
import { extractJsonFromText } from '@libs/llm/structured-output-repair';
import { createLogger } from '@libs/core/log/logger';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { z } from 'zod';
import { TITLE_PROMPT_SPEC } from '@libs/common/utils/codeManagement/suggestion-title';

export const FINDER_DONE_TOOL = 'submitResult' as const;

const finderLogger = createLogger('finder');

/** A single finding as produced by the finder (matches the legacy
 *  FindingsOutput.suggestions item shape). */
export interface FinderSuggestion {
    relevantFile: string;
    language?: string;
    label?: 'bug' | 'security' | 'performance' | 'repo_instruction';
    suggestionContent: string;
    existingCode?: string;
    improvedCode?: string;
    oneSentenceSummary?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    severity?: 'critical' | 'high' | 'medium' | 'low';
    confidence?: number;
    ruleUuid?: string;
    /** Id of the earlier suggestion on this PR this finding revises (#2039). */
    revisesSuggestionId?: string;
    /** Custom agents: `convention` = applies a team guide quoted in `source`. */
    kind?: 'bug' | 'convention';
    source?: { file: string; section?: string; quote: string };
}

const FINDER_LABELS = [
    'bug',
    'security',
    'performance',
    'repo_instruction',
] as const;

/** The finder's output: exactly the fields the prompt asks for, all required.
 *  Snippet, fix, severity and confidence are not part of it at all; a later
 *  enrichment stage adds them. */
const SUBMIT_RESULT_SCHEMA: JSONSchema = {
    type: 'object',
    // additionalProperties:false on every object is required by provider strict
    // tool use / structured output modes.
    additionalProperties: false,
    properties: {
        reasoning: { type: 'string' },
        suggestions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    label: {
                        type: 'string',
                        enum: [
                            'bug',
                            'security',
                            'performance',
                            'repo_instruction',
                        ],
                    },
                    relevantFile: { type: 'string' },
                    relevantLinesStart: { type: 'number' },
                    relevantLinesEnd: { type: 'number' },
                    suggestionContent: { type: 'string' },
                },
                required: [
                    'label',
                    'relevantFile',
                    'relevantLinesStart',
                    'relevantLinesEnd',
                    'suggestionContent',
                ],
            },
        },
    },
    required: ['reasoning', 'suggestions'],
};

/** Custom agents' output: the full finding, as main had it. Their findings
 *  skip the enrichment and the severity classifier, so the agent writes the
 *  snippet, the fix, the title and the severity itself. */
const FULL_SUBMIT_RESULT_SCHEMA: JSONSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        reasoning: { type: 'string' },
        suggestions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    relevantFile: { type: 'string' },
                    language: { type: 'string' },
                    label: { type: 'string', enum: [...FINDER_LABELS] },
                    suggestionContent: { type: 'string' },
                    existingCode: { type: 'string' },
                    improvedCode: { type: 'string' },
                    oneSentenceSummary: {
                        type: 'string',
                        description: TITLE_PROMPT_SPEC,
                    },
                    relevantLinesStart: { type: 'number' },
                    relevantLinesEnd: { type: 'number' },
                    severity: {
                        type: 'string',
                        enum: ['critical', 'high', 'medium', 'low'],
                    },
                    confidence: { type: 'number' },
                    ruleUuid: { type: 'string' },
                },
                required: [
                    'relevantFile',
                    'suggestionContent',
                    'existingCode',
                    'improvedCode',
                    'oneSentenceSummary',
                ],
            },
        },
    },
    required: ['reasoning', 'suggestions'],
};

/** The done tool. No-op execute: it is a finalize SIGNAL the CompletionGatePolicy
 *  detects by name; its input (the findings) is captured in the RunState.
 *  Exported so the overhead estimator (core-agent-loop.adapter) counts its
 *  schema — buildFinderAgentSpec always adds it to the model's tool set, so it
 *  is real per-request overhead. */
export const submitResultTool: AgentTool = {
    name: FINDER_DONE_TOOL,
    description:
        'Submit your final findings and end the review. Call this once you have investigated the changed code.',
    inputSchema: SUBMIT_RESULT_SCHEMA,
    execute: async () => ({ output: 'submitted' }),
};

/** submitResult with `kind` + `source` on each finding (custom agents with
 *  linked guides). Offered only to those agents, so every other review sends
 *  exactly the tool it always did. */
function withConventionFields(tool: AgentTool): AgentTool {
    const schema = tool.inputSchema as any;
    const items = schema.properties.suggestions.items;
    return {
        ...tool,
        inputSchema: {
            ...schema,
            properties: {
                ...schema.properties,
                suggestions: {
                    ...schema.properties.suggestions,
                    items: {
                        ...items,
                        properties: {
                            ...items.properties,
                            kind: {
                                type: 'string',
                                enum: ['bug', 'convention'],
                                description:
                                    "'convention' when the finding applies a rule from a team guide or reports an ast-grep rule match; 'bug' otherwise.",
                            },
                            source: {
                                type: 'object',
                                additionalProperties: false,
                                description:
                                    'Required for kind convention: the guide file, its section heading, and the exact sentence of the rule, copied verbatim. For an ast-grep rule match: file "ast-grep:<ruleId>" and the rule\'s message as quote.',
                                properties: {
                                    file: { type: 'string' },
                                    section: { type: 'string' },
                                    quote: { type: 'string' },
                                },
                                required: ['file', 'quote'],
                            },
                        },
                    },
                },
            },
        },
    };
}

/** submitResult with `revisesSuggestionId` on each finding (#2039/#2020).
 *  Offered only when the PR has earlier suggestions: a first-round review sends
 *  exactly the tool it always did, so this change cannot move its recall. */
/**
 * The done-tool offering only `labels` (the agent's allowed labels, as its
 * prompt states them). Labels the finder does not know are ignored; with none
 * it knows, every label stays.
 */
function withLabels(
    tool: AgentTool,
    labels: readonly string[] | undefined,
): AgentTool {
    const offered = FINDER_LABELS.filter((l) => labels?.includes(l));
    if (!offered.length) return tool;
    const schema = tool.inputSchema as any;
    const items = schema.properties.suggestions.items;
    return {
        ...tool,
        inputSchema: {
            ...schema,
            properties: {
                ...schema.properties,
                suggestions: {
                    ...schema.properties.suggestions,
                    items: {
                        ...items,
                        properties: {
                            ...items.properties,
                            label: { ...items.properties.label, enum: offered },
                        },
                    },
                },
            },
        },
    };
}

function withRevisionField(tool: AgentTool): AgentTool {
    const schema = tool.inputSchema as any;
    const items = schema.properties.suggestions.items;
    return {
        ...tool,
        inputSchema: {
            ...schema,
            properties: {
                ...schema.properties,
                suggestions: {
                    ...schema.properties.suggestions,
                    items: {
                        ...items,
                        properties: {
                            ...items.properties,
                            revisesSuggestionId: { type: 'string' },
                        },
                    },
                },
            },
        },
    };
}

export interface BuildFinderSpecParams {
    systemPrompt: string;
    modelId: string;
    /** The runtime failover target's model id, when the resolved slot has one.
     *  Strict tool use is only enabled when BOTH this and `modelId` support it —
     *  a strict tool built for the primary but swapped onto a non-strict fallback
     *  (e.g. Gemini → OpenAI) is rejected by the fallback's Structured Outputs. */
    fallbackModelId?: string;
    /** Investigation tools (grep/readFile/...) from buildFinderToolRegistry. */
    tools: ToolRegistry;
    /** The labels the agent may report; the done-tool offers only these. */
    labels?: readonly string[];
    coverageLedger: ProgressLedger;
    compressor?: Compressor;
    maxSteps?: number;
    /** Provider options (reasoning/thinking config) forwarded to the model. */
    providerOptions?: Readonly<Record<string, unknown>>;
    /** Cost-span run name for this finder's leaf model calls (e.g.
     *  `code-review-bug`). Buckets the usage span to `review` in `deriveArea`.
     *  Defaults to `code-review` (still `review`) when unset. */
    usageRunName?: string;
    /** Cost-span agentName (the review agent's identity name). */
    agentName?: string;
    /** The PR has earlier suggestions: the done-tool accepts
     *  `revisesSuggestionId` (see withRevisionField). */
    acceptsRevisions?: boolean;
    /** A custom agent with linked guides: the done-tool accepts `kind` +
     *  `source` (see withConventionFields). */
    acceptsConventions?: boolean;
    /** A custom agent: the done-tool takes the full finding
     *  (FULL_SUBMIT_RESULT_SCHEMA). */
    fullOutput?: boolean;
    /** Provider options attached to the system message (e.g. Anthropic prompt
     *  caching) so the long system prompt is cached across the loop's steps. */
}

export function buildFinderAgentSpec(params: BuildFinderSpecParams): AgentSpec {
    const submitTool = params.fullOutput
        ? { ...submitResultTool, inputSchema: FULL_SUBMIT_RESULT_SCHEMA }
        : submitResultTool;
    let doneTool = params.acceptsRevisions
        ? withRevisionField(submitTool)
        : submitTool;
    if (params.acceptsConventions) doneTool = withConventionFields(doneTool);
    doneTool = withLabels(doneTool, params.labels);
    const tools = new InMemoryToolRegistry([
        ...params.tools.list(),
        // Enable strict/structured tool calling on the done-tool for
        // strict-capable models (Gemini VALIDATED mode) so the findings payload
        // can't be omitted or emitted as prose. Best-effort otherwise. NOT
        // enabled for Anthropic — see model-strictness.ts (it craters recall).
        // Considers the failover target too: a strict tool built for a Gemini
        // primary must NOT be sent to an OpenAI fallback (it rejects the schema).
        {
            ...doneTool,
            strict: supportsStrictToolsForRun(
                params.modelId,
                params.fallbackModelId,
            ),
        },
    ]);

    const policies = [
        new BudgetPolicy(),
        ...(params.compressor
            ? [new CompressionPolicy(params.compressor)]
            : []),
        new CompletionGatePolicy(params.coverageLedger, {
            doneToolName: FINDER_DONE_TOOL,
        }),
        // Ports the legacy "force-text": in the last steps, restrict to the done
        // tool so the agent finalizes instead of running out of steps with
        // nothing submitted (which would lose all findings).
        new ForceFinalizePolicy({ doneToolName: FINDER_DONE_TOOL }),
    ];

    return {
        id: 'finder',
        // Cost-span identity: LLM.run records the ONE usage span per model call
        // with this runName; `deriveArea` buckets `code-review*` under `review`.
        runName: params.usageRunName ?? 'code-review',
        agentName: params.agentName,
        phase: 'review',
        systemPrompt: params.systemPrompt,
        tools,
        policies,
        maxSteps: params.maxSteps ?? 20,
        // CAPTURE concern: the runner materializes submitResult's payload into
        // RunState.artifacts. Stopping ON submitResult is the CompletionGatePolicy's
        // doneToolName concern — same tool, distinct roles.
        resultToolName: FINDER_DONE_TOOL,
        providerOptions: params.providerOptions,
    };
}

/** Extract findings from a finished run by reading the run's materialized
 *  artifacts (the "result tool" convention — the runner captures every
 *  submitResult call into RunState.artifacts in step order). The LAST artifact
 *  is the finder's final output. Falls back to [] if the agent never finalized
 *  (budget-exhausted). No hand re-scan of steps — that is the runner's job. */
/** The findings of the submits before `latest`, in the order they came. */
function earlierSubmittedFindings(
    state: RunState,
    latest: RunState['artifacts'][number],
    telemetryMetadata?: { organizationId?: string; modelId?: string },
): FinderSuggestion[] {
    return state.artifacts
        .filter((a) => a.type === FINDER_DONE_TOOL && a !== latest)
        .flatMap(
            (a) =>
                (sanitizeFindingsResult(a.payload as any, telemetryMetadata)
                    ?.suggestions ?? []) as FinderSuggestion[],
        );
}

export function extractFindings(
    state: RunState,
    // Purely for the [LLM_ENVELOPE] logs sanitizeFindingsResult emits — see
    // that function's own doc comment for why this is an untyped inline
    // shape rather than LangfuseTelemetryMetadata.
    telemetryMetadata?: { organizationId?: string; modelId?: string },
): {
    reasoning: string;
    suggestions: FinderSuggestion[];
} {
    // 1. The result-tool artifact (submitResult), latest first, Zod-validated.
    const artifact = [...state.artifacts]
        .reverse()
        .find((a) => a.type === FINDER_DONE_TOOL);
    // OBSERVABILITY: "zero findings" has THREE distinct causes here and none
    // was recorded — a valid artifact with an empty list, an unusable artifact
    // (empty submitResult({}) or prose), and a missing artifact. Without this,
    // the published number does not tell "reviewed and found nothing" from
    // "broke the format".
    // Validated ONCE: a second pass logged every failure twice (#2112).
    const clean = artifact
        ? sanitizeFindingsResult(artifact.payload, telemetryMetadata)
        : null;
    (state as any).__findingsOutcome = !artifact
        ? 'no-artifact'
        : clean
          ? 'structured'
          : 'artifact-unusable';
    if (artifact) {
        if (clean) {
            const suggestions = (clean.suggestions ?? []) as FinderSuggestion[];
            // A model that submits its findings and then submits again with
            // none ("already recorded") still means the first ones. Reading
            // only the last submit lost them, and the prose recovery then
            // re-extracted them under new titles, posting each twice.
            return {
                reasoning: clean.reasoning ?? '',
                suggestions:
                    suggestions.length > 0
                        ? suggestions
                        : earlierSubmittedFindings(
                              state,
                              artifact,
                              telemetryMetadata,
                          ),
            };
        }
        // Artifact present but unusable — either empty args (e.g. Gemini
        // `submitResult({})`) or, for Anthropic, the model wrote its findings as
        // PROSE in `reasoning` and omitted `suggestions`. Preserve that prose so
        // a downstream fallback-LLM can re-structure it into findings; otherwise
        // those (real) findings are silently lost.
        // When the findings came as JSON text that could not be parsed, that
        // text goes to the recoverer too: the findings are in it, not in
        // `reasoning` (#2112).
        const payload = artifact.payload as Record<string, unknown> | string;
        const proseReasoning = [
            typeof payload === 'object' &&
            typeof payload?.reasoning === 'string'
                ? payload.reasoning
                : '',
            typeof payload === 'string'
                ? payload
                : unparsedFindingsText(payload),
        ]
            .filter((t) => t.trim() !== '')
            .join('\n\n');
        return (
            findingsFromText(state, telemetryMetadata) ?? {
                reasoning: proseReasoning,
                suggestions: [],
            }
        );
    }
    // 2. Fallback: the model answered in TEXT instead of calling submitResult
    //    (or called it empty). Recover the findings JSON from its final text.
    return (
        findingsFromText(state, telemetryMetadata) ?? {
            reasoning: '',
            suggestions: [],
        }
    );
}

/** The findings a payload holds as text, under the key, an alias, or the
 *  arguments of a tool-call wrapper — '' when there is none. */
function unparsedFindingsText(
    payload: Record<string, unknown> | undefined,
    depth = 0,
): string {
    if (!payload || typeof payload !== 'object' || depth > 3) return '';
    for (const k of [
        'suggestions',
        'findings',
        'codeSuggestions',
        'arguments',
    ]) {
        if (typeof payload[k] === 'string') return payload[k] as string;
    }
    for (const k of ['parameters', 'arguments', 'result', 'data', 'output']) {
        const inner = payload[k];
        if (inner && typeof inner === 'object') {
            const t = unparsedFindingsText(
                inner as Record<string, unknown>,
                depth + 1,
            );
            if (t) return t;
        }
    }
    return '';
}

/** Recover findings from the model's final text — covers "answered in prose/JSON
 *  instead of calling submitResult" and empty-arg submitResult. */
function findingsFromText(
    state: RunState,
    telemetryMetadata?: { organizationId?: string; modelId?: string },
): {
    reasoning: string;
    suggestions: FinderSuggestion[];
} | null {
    for (let i = state.steps.length - 1; i >= 0; i--) {
        const text = state.steps[i].message.content;
        if (typeof text !== 'string' || !text.trim()) {
            continue;
        }
        const json = extractJsonFromText(text);
        if (!json) continue;
        try {
            const clean = sanitizeFindingsResult(
                JSON.parse(json),
                telemetryMetadata,
            );
            if (clean) {
                return {
                    reasoning: clean.reasoning ?? '',
                    suggestions: (clean.suggestions ??
                        []) as FinderSuggestion[],
                };
            }
        } catch {
            // not valid JSON in this step — try an earlier one
        }
    }
    // KNOWN LIMITATION (E) — total parse failure under-reports SILENTLY: no step
    // held extractable JSON. The caller falls to prose recovery
    // (recoverFindingsFromProse), which also returns [] when the prose doesn't read
    // like findings. If BOTH miss, the finder's findings are dropped with no
    // counter/log — a review can silently under-report. Accepted for now; a
    // parse-failure metric would make the drop observable.
    return null;
}

// ─── Prose-findings recovery (fallback LLM) ─────────────────────────────────
// When the finder writes its findings as PROSE (in `reasoning`) and omits the
// structured `suggestions` array — the dominant Anthropic failure mode — the
// findings are otherwise lost. A cheap internal LLM re-structures that prose
// into findings. This does NOT constrain the finder (unlike strict tool use,
// which craters recall); it only recovers what the model already found.

/** Cheap gate: only pay for the recovery LLM when the prose actually reads like
 *  code-review findings (file/line refs + issue verbs), not investigation notes. */
function looksLikeFindings(text: string): boolean {
    if (!text || text.length < 80) return false;
    const l = text.toLowerCase();
    const signals = [
        /\b(bug|issue|vulnerabilit|race|leak|npe|null|missing|incorrect|unsafe|injection|overflow|deadlock|toctou)\b/,
        /\b(should|must|fix|instead|because|so that|would)\b/,
        /(\.(ts|tsx|js|jsx|go|rb|py|java|rs|kt)\b|:\d+|line\s*\d+)/,
    ];
    return signals.filter((r) => r.test(l)).length >= 2;
}

const RECOVERY_SCHEMA = z.object({
    suggestions: z.array(
        z.object({
            relevantFile: z.string(),
            suggestionContent: z.string(),
            // Same lean fields as submitResult. Nullable: prose that describes a
            // defect may not name its label or lines, and requiring them made
            // the WHOLE recovery fail with "response did not match schema"
            // (measured on GPT-6.1, 30/09).
            label: z.string().nullable(),
            relevantLinesStart: z.number().nullable(),
            relevantLinesEnd: z.number().nullable(),
        }),
    ),
});

/** A custom agent's recovery: the full finding, as its submitResult asks.
 *  Its findings skip the enrichment and the severity classifier, so what the
 *  recovery leaves out would post missing. */
const FULL_RECOVERY_SCHEMA = z.object({
    suggestions: z.array(
        z.object({
            relevantFile: z.string(),
            suggestionContent: z.string(),
            existingCode: z.string(),
            improvedCode: z.string(),
            language: z.string().nullable(),
            label: z.string().nullable(),
            oneSentenceSummary: z
                .string()
                .nullable()
                .describe(TITLE_PROMPT_SPEC),
            relevantLinesStart: z.number().nullable(),
            relevantLinesEnd: z.number().nullable(),
            severity: z.string().nullable(),
            confidence: z.number().nullable(),
        }),
    ),
});

const withRevisionId = (schema: typeof RECOVERY_SCHEMA | typeof FULL_RECOVERY_SCHEMA) =>
    z.object({
        suggestions: z.array(
            schema.shape.suggestions.element.extend({
                revisesSuggestionId: z.string().optional(),
            }),
        ),
    });

/** Injected capability: re-structure a prose `reasoning` into findings. The
 *  domain (finder/recall passes) depends only on this function; the adapter
 *  wires it to the concrete internal-model fallback. Undefined = recovery off. */
export type ProseRecoverer = (reasoning: string) => Promise<FinderSuggestion[]>;

/** Extract findings from a run, and — if the model produced NONE but wrote
 *  finding-like prose in `reasoning` (the Anthropic omission mode) — recover
 *  them via the injected recoverer. Applied at EVERY extraction seam (main
 *  finder + each recall pass) so an omission in any pass is caught. */
export async function extractFindingsWithRecovery(
    state: RunState,
    recover?: ProseRecoverer,
    telemetryMetadata?: { organizationId?: string; modelId?: string },
): Promise<FinderFindings> {
    const found = extractFindings(state, telemetryMetadata);
    if (found.suggestions.length > 0 || !recover) return found;
    const recovered = await recover(found.reasoning);
    // Logged when there was something to recover: an unusable or missing
    // result, or prose the recoverer turned into findings.
    if (
        (state as any).__findingsOutcome !== 'structured' ||
        recovered.length > 0
    ) {
        finderLogger.log({
            message: `[DONE-TOOL] prose recovery returned ${recovered.length} finding(s)`,
            context: 'finder',
            metadata: {
                recovered: recovered.length,
                outcome: (state as any).__findingsOutcome,
                organizationId: telemetryMetadata?.organizationId,
                modelId: telemetryMetadata?.modelId,
            },
        });
    }
    return recovered.length > 0
        ? { reasoning: found.reasoning, suggestions: recovered }
        : found;
}

export function recoverLeniently(err: unknown): FinderSuggestion[] {
    try {
        const e = err as { text?: string; value?: unknown; cause?: { value?: unknown } };
        const raw =
            e?.value ?? e?.cause?.value ?? (e?.text ? JSON.parse(extractJsonFromText(e.text) ?? e.text) : undefined);
        const list = (raw as { suggestions?: unknown })?.suggestions;
        if (!Array.isArray(list)) return [];
        return list
            .filter(
                (s): s is Record<string, unknown> =>
                    !!s &&
                    typeof (s as Record<string, unknown>).relevantFile === 'string' &&
                    typeof (s as Record<string, unknown>).suggestionContent === 'string',
            ) as unknown as FinderSuggestion[];
    } catch {
        // Best-effort: recovery must never break the review.
        return [];
    }
}

export async function recoverFindingsFromProse(
    prose: string,
    byokConfig: NormalizedModel | undefined,
    organizationId: string | undefined,
    usageRunName?: string,
    previousDecisions?: readonly PrDecisionRecord[],
    prebuiltModel?: LanguageModel,
    teamId?: string,
    /** A custom agent: recover the full finding (FULL_RECOVERY_SCHEMA). */
    fullOutput?: boolean,
): Promise<FinderSuggestion[]> {
    if (!looksLikeFindings(prose)) return [];
    const base = fullOutput ? FULL_RECOVERY_SCHEMA : RECOVERY_SCHEMA;
    try {
        // ONE primitive: LLM.run resolves the slot (or managed default), owns the
        // span + the json_schema→json_object fallback the recovery pass needs, and
        // returns the parsed object. The runName buckets this recovery call's
        // usage span to `review` (deriveArea) alongside the finder/verify calls —
        // it is part of the same review, not a separate `other` area.
        const result = await LLM.run({
            byokConfig,
            schema: previousDecisions?.length ? withRevisionId(base) : base,
            // The title rule (#2157) mirrors the finder's own schema. The
            // "Respond with a JSON object" sentence must stay: the text must
            // literally contain the word "json" somewhere: OpenAI (and
            // OpenAI-compatible providers) reject a `json_object`
            // response-format request outright otherwise —
            // their own error is "'messages' must contain the word 'json'
            // in some form" — which is exactly the json_schema→json_object
            // fallback LLM.run owns for this call (prod incident,
            // 2026-09-17: this silently 400'd recovery for every provider
            // needing that fallback, e.g. gpt-5.6-sol/gpt-5.6-terra).
            // Verified live against the real OpenAI API (2026-09-17): the
            // exact same request 400s with that message without this
            // sentence, and 200s with it.
            // Since #1916 the structured executor guarantees the same thing
            // centrally for every json_object route (it writes the schema AND
            // the keyword into the system prompt), so this sentence is now a
            // belt-and-braces duplicate rather than the only thing standing
            // between this call and a 400.
            user:
                "The following is a code reviewer's analysis written as " +
                'prose. Extract each defect the reviewer CONCLUDED is ' +
                'present in the code into the structured schema — one ' +
                'entry per distinct issue, using the file paths and line ' +
                'numbers mentioned.\n\n' +
                (fullOutput
                    ? `For each finding also give the cited code, the fixed code, its severity and a title: ${TITLE_PROMPT_SPEC}.\n\n`
                    : '') +
                'Leave out everything the reviewer did not conclude is a ' +
                'defect:\n' +
                '- a hypothesis the analysis checked and then dismissed, ' +
                'ruled out, or found handled elsewhere (e.g. "summing ' +
                'floats would lose precision, but amounts are stored as ' +
                'integer cents");\n' +
                '- descriptions of what the change does, intentional ' +
                'changes, and code the reviewer judged correct;\n' +
                '- remarks the reviewer itself says are not a correctness, ' +
                'security or performance issue (missing tests, style, ' +
                'naming);\n' +
                '- questions the analysis raises and answers itself.\n' +
                'If the analysis concludes there is nothing to fix, return ' +
                'an empty suggestions list. Do NOT invent findings.' +
                `\n\nRespond with a JSON object.\n\nANALYSIS:\n${prose}` +
                (previousDecisions?.length
                    ? `\n\n${formatPreviousDecisions(previousDecisions)}\nPreserve the earlier suggestion's Id in revisesSuggestionId when the analysis revises it. Do not invent a relationship absent from the analysis; omit the field for unrelated findings.`
                    : ''),
            runName: usageRunName
                ? `${usageRunName}-recovery`
                : 'code-review-recovery',
            organizationId,
            // Eval-only: the review's own already-built model. Unset in
            // production, where byokConfig is the slot.
            prebuiltModel,
        });
        return (result.suggestions ?? []) as unknown as FinderSuggestion[];
    } catch (err) {
        finderLogger.warn({
            message: `[RECOVERY] prose recovery call failed: ${(err as Error)?.message ?? String(err)}`,
            context: 'finder',
            metadata: {
                organizationId,
                teamId,
                runName: usageRunName
                    ? `${usageRunName}-recovery`
                    : 'code-review-recovery',
            },
        });
        // Kimi K3 OMITS the optional fields instead of sending null, and
        // strict validation fails the whole recovery (smoke test, 01/10). The
        // schema cannot make them optional (OpenAI strict mode requires every
        // field declared), so read the returned JSON requiring only what the
        // main schema requires: file and description.
        return recoverLeniently(err);
    }
}

// ─── Finder + Verify (parity orchestration on the SAME runner) ──────────────

export interface RunFinderWithVerifyParams {
    runner: AgentRunner;
    finderSpec: AgentSpec;
    /** Model id for the verifier runs. */
    modelId: string;
    /** Failover target model id — threaded to the verifier so its strict tool
     *  use accounts for the failover model (Gemini→OpenAI must not send strict). */
    fallbackModelId?: string;
    /** Investigation tools shared with the verifier. */
    tools: ToolRegistry;
    /** Runner for the verify pass when it runs on its own model (a custom
     *  agent's check slot, #2172). Defaults to `runner`. */
    verifyRunner?: AgentRunner;
    /** Model id of `verifyRunner`'s slot; `modelId` when unset. */
    verifyModelId?: string;
    /** Failover target of `verifyRunner`'s slot. */
    verifyFallbackModelId?: string;
    /** Provider options built for `verifyRunner`'s model. */
    verifyProviderOptions?: Readonly<Record<string, unknown>>;
    /** Verify concurrency (default 4). */
    concurrency?: number;
    /** Provider options (reasoning/thinking config) forwarded to verifier runs. */
    providerOptions?: Readonly<Record<string, unknown>>;
    /** System-message provider options (e.g. Anthropic prompt caching), forwarded
     *  to the finder spec and the verifier runs. */
    /** Skip the recall pass entirely (fast mode / self-contained trial). */
    skipHeavyPasses?: boolean;
    /** Skip ONLY the synthesis-rescue pass. */
    skipSynthesisRescue?: boolean;
    /** Langfuse telemetry context (org/team/PR/repo) — names the finder, recall
     *  and per-finding verify observations so the trace is attributable. */
    telemetryMetadata?: LangfuseTelemetryMetadata;
    /** Agent name (finder/security/...) — prefixes every observation name. */
    agentName?: string;
    /** Cost-span run name base (e.g. `code-review-bug`) forwarded to the verifier
     *  runs so their leaf usage spans bucket to `review` in `deriveArea`. */
    usageRunName?: string;
    /** Injected prose-findings recovery capability (see ProseRecoverer). The
     *  adapter wires it to the internal-model fallback; omit to disable. */
    recoverProse?: ProseRecoverer;
    /** Suggestions already posted on THIS PR in a previous review round
     *  (issue #1313). Forwarded to the LlmVerifier, which filters by file per
     *  candidate — see LlmVerifierParams. */
    previousDecisions?: PrDecisionRecord[];
    /** Forwarded to the LlmVerifier as evidence for `repo_instruction`
     *  candidates. */
    repoInstructions?: RepoInstructionsContext;
    /** Hold a finding that cites an instruction file under another label to
     *  the repo_instruction quote check. Off for custom agents, whose guides
     *  can be the same files and take the convention check. Default on. */
    checksInstructionCitations?: boolean;
    /** Second pass for convention findings (custom agents with linked guides).
     *  When set, `kind: 'convention'` findings take the quote check and the
     *  convention verifier instead of HV2. Absent → every finding takes HV2,
     *  exactly as before. */
    conventionCheck?: ConventionCheckParams;
    /** A custom agent's team system (MCP) tools; see RecallPassesParams. */
    teamSystemTools?: string[];
    /** A custom agent kept to its lane: what it may report. The verifier
     *  drops a bug finding outside it (see verifierPromptFor), and the
     *  synthesis rescue asks only for missed findings within it. Absent →
     *  both run exactly as before. */
    laneFocus?: string;
}

export interface ConventionCheckParams {
    /** Reads a guide as it is on the PR's target branch. */
    readGuide: GuideFileReader;
    /** Lists a skill's files on the target branch, so a rule quoted from a
     *  file beside SKILL.md is found there. */
    listGuideDir?: GuideDirLister;
    /** Guides linked to this agent. Non-empty → only these may be quoted, and
     *  the recall pass asks for missed violations of them. */
    guideFiles?: string[];
    /** The custom agent's instructions: a rule cited from `TeamInstructions`
     *  is checked against them. */
    teamInstructions?: string;
    /** What the ast-grep tool returned during this review (see
     *  recordAstGrepOutputs). Absent → no finding is proven by ast-grep. */
    astGrepLog?: AstGrepOutputLog;
}

export interface VerifyUsage {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
}

export interface FinderWithVerifyResult {
    reasoning: string;
    kept: FinderSuggestion[];
    /** Per-finding verifier tool evidence for the KEPT findings (same order as
     *  `kept`): which files the verifier itself read/grepped while judging each.
     *  Empty summary when the verifier used no tools for that finding. */
    keptEvidence: ToolEvidenceSummary[];
    /** How each KEPT finding's verdict was read (same order as `kept`) — the
     *  verify funnel's provenance, so a `keep` that is really a parse miss is
     *  visible in the trace instead of indistinguishable from a judged keep
     *  (issue #1937). */
    keptParseMode: VerdictParseMode[];
    droppedByVerify: Array<{
        finding: FinderSuggestion;
        evidence?: string;
        verifierEvidence: ToolEvidenceSummary;
        parseMode: VerdictParseMode;
    }>;
    /** Candidates whose verify run failed (`parseMode: 'verify-error'`), so
     *  nobody judged them. Not in `kept`: a review never publishes a finding
     *  as checked when the check did not run (#2171). */
    unverified: Array<{ finding: FinderSuggestion; error: string }>;
    /** Convention findings whose quote is not in the cited guide on the target
     *  branch (`quote-not-found`): dropped before any verify, kept apart so
     *  the gate is observable. Always empty without `conventionCheck`. */
    droppedByQuoteCheck: ConventionCheckRejected[];
    /** The finder's RunState (for usage/steps/trace mapping by callers). */
    finderState: RunState;
    /** Token usage of the verify sub-step (sum across verifier runs). The
     *  finder's own usage is in finderState.usage; this is reported separately
     *  so callers can attribute cost — it is NOT in finderState. */
    verifyUsage: VerifyUsage;
    /** Wall-clock of the verify sub-step (first pass + evidence gate), in ms.
     *  Undefined when verify did not run. Without it the verifier's share of
     *  review latency could only be inferred by subtraction. */
    verifyMs?: number;
    /** Token usage of the recall pass (the extra synthesis-rescue finder run).
     *  NOT in finderState — summed here so the caller can add it to the finder
     *  cost. */
    recallUsage: VerifyUsage;
    /** Per-pass stats (the base pass and the synthesis rescue), so a pass
     *  that pays for itself can be told from one that doesn't. */
    passStats: RecallPassStat[];
}

const ZERO_VERIFY_USAGE: VerifyUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
};

/** The runner and model the verify pass uses: its own when the caller gave
 *  one (a custom agent's check slot), the finder's otherwise. */
function verifyModelOf(params: RunFinderWithVerifyParams): {
    runner: AgentRunner;
    modelId: string;
    fallbackModelId?: string;
    providerOptions?: Readonly<Record<string, unknown>>;
} {
    if (!params.verifyRunner) {
        return {
            runner: params.runner,
            modelId: params.modelId,
            fallbackModelId: params.fallbackModelId,
            providerOptions: params.providerOptions,
        };
    }
    return {
        runner: params.verifyRunner,
        modelId: params.verifyModelId ?? params.modelId,
        fallbackModelId: params.verifyFallbackModelId,
        providerOptions: params.verifyProviderOptions,
    };
}

/**
 * Runs the finder, then verifies each finding on the SAME runner (HV2
 * refute-to-drop). This is the parity path with the legacy runAgentLoop
 * (finder + in-loop verify) — but as composition, no second loop.
 */
export async function runFinderWithVerify(
    params: RunFinderWithVerifyParams,
    input: { prompt: string },
    ctx: ToolContext,
): Promise<FinderWithVerifyResult> {
    const baseT0 = Date.now();
    const finderState = await params.runner.run(
        params.finderSpec,
        {
            ...input,
            ...toAiSdkTelemetryArgs(
                buildLangfuseTelemetry(
                    params.agentName ?? 'finder',
                    params.telemetryMetadata,
                ),
            ),
        },
        ctx,
    );
    // Main finder findings — with prose-recovery applied (the same wrapper the
    // recall passes use, so an omission in any pass is caught consistently).
    const baseMs = Date.now() - baseT0;
    const base = await extractFindingsWithRecovery(
        finderState,
        params.recoverProse,
        { ...params.telemetryMetadata, modelId: params.modelId },
    );
    // The generalist as a pass, measured like the others: without it its cost
    // and time only showed up summed into the review total (#1821).
    const baseStat: RecallPassStat = (() => {
        const u = usageOf(finderState.usage);
        const calls = collectToolCalls(finderState);
        return {
            label: 'generalist-base',
            added: base.suggestions?.length ?? 0,
            ms: baseMs,
            startMs: 0,
            startEpochMs: baseT0,
            steps: finderState.steps.length,
            toolCalls: calls.length,
            fullFileReads: calls.filter(
                (c) =>
                    c.tool === 'readFile' &&
                    !(c.args as { startLine?: number })?.startLine,
            ).length,
            inputTokens: u.inputTokens,
            cacheReadTokens: u.cacheReadTokens,
            outputTokens: u.outputTokens,
            reasoningTokens: u.reasoningTokens,
        };
    })();

    // RECALL PASS: synthesis rescue — one extra finder run that re-thinks from
    // the evidence already gathered and surfaces concrete MISSED bugs BEFORE
    // verify filters, dedup-merged into the candidate set. (Soft coverage: the
    // coverage-recovery + 2nd/3rd-chance passes were removed to match the
    // validated depth-first engine — main pass only, no coverage-forced re-runs.)
    const recall = await runRecallPasses(
        base,
        {
            runner: params.runner,
            finderSpec: params.finderSpec,
            finderState,
            userPrompt: input.prompt,
            skipHeavyPasses: params.skipHeavyPasses,
            skipSynthesisRescue: params.skipSynthesisRescue,
            telemetryMetadata: params.telemetryMetadata,
            modelId: params.modelId,
            agentName: params.agentName,
            recoverProse: params.recoverProse,
            conventionGuides: params.conventionCheck?.guideFiles,
            teamSystemTools: params.teamSystemTools,
            laneScoped: !!params.laneFocus,
        },
        ctx,
    );
    const reasoning = recall.findings.reasoning;
    const suggestions = recall.findings.suggestions;
    const recallUsage = recall.usage;
    const passStats = [baseStat, ...recall.passStats];

    if (suggestions.length === 0) {
        return {
            reasoning,
            kept: [],
            keptEvidence: [],
            keptParseMode: [],
            droppedByVerify: [],
            unverified: [],
            droppedByQuoteCheck: [],
            finderState,
            verifyUsage: ZERO_VERIFY_USAGE,
            recallUsage,
            passStats,
        };
    }

    // SECOND PASS ROUTING (custom agents). A convention finding is judged
    // against the team's rule, not by HV2 — which drops "style" and "missing
    // X" by rule and never sees the guide. First the deterministic quote check
    // on the target branch, then the convention verifier. A finding an
    // ast-grep call in this run actually matched is proven and skips both.
    // Without `conventionCheck` everything below sees only `bugs` = all.
    const verifyT0 = Date.now();
    const route = params.conventionCheck
        ? await routeByKind(suggestions, params.conventionCheck, {
              organizationId: params.telemetryMetadata?.organizationId,
              teamId: params.telemetryMetadata?.teamId,
              repositoryId: params.telemetryMetadata?.repositoryId,
              pullRequestId: params.telemetryMetadata?.pullRequestId,
              agent: params.agentName,
          })
        : {
              bugs: suggestions,
              proven: [] as FinderSuggestion[],
              conventions: [] as FinderSuggestion[],
              sectionOf: new Map<FinderSuggestion, string>(),
              rejected: [] as ConventionCheckRejected[],
          };

    // HV2 on the bug findings (refute-to-drop + evidence gate), on the check
    // model when the caller gave one.
    const verify = verifyModelOf(params);
    // EVIDENCE GATE input: the base pass's reads AND the recall pass's: a
    // finding on a file the pass read itself is evidenced.
    const investigated = new Set([
        ...strongFilesFromRun(finderState),
        ...(recall.investigatedFiles ?? []),
    ]);
    const hv2 = await verifyFindings(
        {
            ...params,
            runner: verify.runner,
            modelId: verify.modelId,
            fallbackModelId: verify.fallbackModelId,
            providerOptions: verify.providerOptions,
        },
        route.bugs,
        investigated,
        ctx,
    );
    let kept = hv2.kept;
    let dropped = hv2.dropped;
    // Per-finding verifier verdict (carries the verifier's investigation tool
    // calls) so we can attribute per-finding verifier evidence to the trace.
    const verdictByFinding = hv2.verdictByFinding;

    // Convention findings that passed the quote check. The quote check is
    // their evidence gate: they never take the HV2 full re-verify above,
    // which would drop them as style.
    let conventionUsage: VerifyUsage = ZERO_VERIFY_USAGE;
    if (route.conventions.length > 0) {
        // Judged on the check model, like the HV2 verifier above.
        const conventionVerifier = new ConventionVerifier(verify.runner, {
            modelId: verify.modelId,
            fallbackModelId: verify.fallbackModelId,
            tools: params.tools,
            sectionOf: (f) => route.sectionOf.get(f),
            providerOptions: verify.providerOptions,
            telemetryMetadata: params.telemetryMetadata,
            agentName: params.agentName,
            usageRunName: params.usageRunName,
            previousDecisions: params.previousDecisions,
        });
        const conv = await runVerificationPass<FinderSuggestion>(
            {
                candidates: route.conventions,
                verifier: conventionVerifier,
                concurrency: params.concurrency,
            },
            ctx,
        );
        conv.kept.forEach((f, i) =>
            verdictByFinding.set(f, conv.keptVerdicts[i]),
        );
        conv.dropped.forEach((d) =>
            verdictByFinding.set(d.candidate, d.verdict),
        );
        kept = [...kept, ...conv.kept];
        dropped = [...dropped, ...conv.dropped];
        conventionUsage = { ...conventionVerifier.usage };
    }
    for (const f of route.proven) {
        verdictByFinding.set(f, {
            keep: true,
            rationale: 'ast-grep match',
            toolCalls: [],
            parseMode: 'proof',
        });
    }
    if (route.conventions.length > 0 || route.proven.length > 0) {
        // Back to the finder's order, so routing never reorders the output.
        const order = new Map(suggestions.map((s, i) => [s, i]));
        kept = [...kept, ...route.proven].sort(
            (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
        );
    }
    const verifyMs = Date.now() - verifyT0;

    // Map the generic verdict.toolCalls (name/args/result) into the review
    // ToolEvidenceSummary (strong=readFile/checkTypes files, weak=grep hits).
    const evidenceOf = (f: FinderSuggestion): ToolEvidenceSummary =>
        buildToolEvidenceSummary(
            (verdictByFinding.get(f)?.toolCalls ?? []).map((tc) => ({
                tool: tc.name,
                toolName: tc.name,
                args: tc.args ?? {},
                result: tc.result,
            })),
        );

    // The harness speaks neutral "candidate"; code-review's own term is "finding".
    const parseModeOf = (f: FinderSuggestion): VerdictParseMode =>
        verdictByFinding.get(f)?.parseMode ?? 'default-keep';

    // The Verifier port fails open, so a candidate whose verify run failed
    // comes back as kept. Nobody judged it: take it out of the published set
    // and report it on its own (#2171). The evidence gate's re-verify already
    // superseded the first verdict above, so this reads the final one.
    const unverified = kept
        .filter((f) => parseModeOf(f) === 'verify-error')
        .map((f) => ({
            finding: f,
            error:
                verdictByFinding.get(f)?.rationale ??
                'verification unavailable',
        }));
    if (unverified.length > 0) {
        const unverifiedSet = new Set(unverified.map((u) => u.finding));
        kept = kept.filter((f) => !unverifiedSet.has(f));
    }

    return {
        reasoning,
        kept,
        keptEvidence: kept.map(evidenceOf),
        keptParseMode: kept.map(parseModeOf),
        droppedByVerify: dropped.map((d) => ({
            finding: d.candidate,
            evidence: d.verdict.rationale,
            verifierEvidence: evidenceOf(d.candidate),
            parseMode: d.verdict.parseMode ?? 'default-keep',
        })),
        unverified,
        droppedByQuoteCheck: route.rejected,
        finderState,
        verifyUsage: sumVerifyUsage(hv2.verifyUsage, conventionUsage),
        verifyMs,
        recallUsage,
        passStats,
    };
}

/**
 * The verify step: each candidate judged by the verifier (refute-to-drop), then
 * the evidence gate, which re-verifies in full a finding kept on a file the
 * finder never investigated (`investigated`: strongFilesFromRun of its run).
 * Called by runFinderWithVerify; the funnel's verify eval calls it too.
 */
export async function verifyFindings(
    params: Pick<
        RunFinderWithVerifyParams,
        | 'runner'
        | 'modelId'
        | 'fallbackModelId'
        | 'tools'
        | 'concurrency'
        | 'providerOptions'
        | 'telemetryMetadata'
        | 'agentName'
        | 'usageRunName'
        | 'previousDecisions'
        | 'repoInstructions'
        | 'checksInstructionCitations'
        | 'laneFocus'
    >,
    suggestions: FinderSuggestion[],
    investigated: Set<string>,
    ctx: ToolContext,
): Promise<{
    kept: FinderSuggestion[];
    dropped: { candidate: FinderSuggestion; verdict: Verdict }[];
    verdictByFinding: Map<FinderSuggestion, Verdict>;
    verifyUsage: VerifyUsage;
}> {
    // A finding that cites an instruction file under another label is a
    // convention break too. Before verify, one quoting the target branch is
    // relabeled repo_instruction, so the verifier judges it against the file
    // (appliesTo, the changed line); one that does not (the setting is off,
    // or it quotes the PR's own version) is dropped. A finding on the
    // instruction file itself reviews that file and is left alone.
    const preDropped: { candidate: FinderSuggestion; verdict: Verdict }[] = [];
    let candidates = suggestions;
    if (params.checksInstructionCitations !== false) {
        const relabeled = new Map<FinderSuggestion, FinderSuggestion>();
        const unsupported = new Set<FinderSuggestion>();
        for (const f of suggestions) {
            if (
                f.label === 'repo_instruction' ||
                !citesRepoInstruction(f, params.repoInstructions) ||
                isRepoInstructionFile(f.relevantFile, params.repoInstructions)
            ) {
                continue;
            }
            if (
                quotesRepoInstruction(
                    f.suggestionContent,
                    params.repoInstructions,
                )
            ) {
                relabeled.set(f, { ...f, label: 'repo_instruction' });
            } else {
                unsupported.add(f);
            }
        }
        if (relabeled.size || unsupported.size) {
            candidates = suggestions
                .filter((f) => !unsupported.has(f))
                .map((f) => relabeled.get(f) ?? f);
            const rationale = params.repoInstructions?.files?.length
                ? 'It cites an instruction file without quoting it as merged on the target branch.'
                : 'It cites an instruction file, and coding-agent instructions are off for this review.';
            for (const candidate of unsupported) {
                preDropped.push({
                    candidate,
                    verdict: { keep: false, rationale },
                });
            }
            finderLogger.log({
                message: `Findings citing an instruction file under another label: ${relabeled.size} relabeled repo_instruction, ${unsupported.size} dropped`,
                context: 'finder.repo-instruction-citation',
                metadata: {
                    ...params.telemetryMetadata,
                    agentName: params.agentName,
                    instructionsOn: !!params.repoInstructions?.files?.length,
                    relabeled: [...relabeled.keys()].map((f) => f.relevantFile),
                    dropped: [...unsupported].map((f) => f.relevantFile),
                },
            });
        }
    }

    // Verify each finding (HV2 refute-to-drop) at the light depth; the
    // evidence gate below re-verifies at the full depth.
    const verifier = new LlmVerifier(params.runner, {
        modelId: params.modelId,
        fallbackModelId: params.fallbackModelId,
        tools: params.tools,
        providerOptions: params.providerOptions,
        telemetryMetadata: params.telemetryMetadata,
        agentName: params.agentName,
        usageRunName: params.usageRunName,
        previousDecisions: params.previousDecisions,
        repoInstructions: params.repoInstructions,
        laneFocus: params.laneFocus,
    });
    const pass = await runVerificationPass<FinderSuggestion>(
        { candidates, verifier, concurrency: params.concurrency },
        ctx,
    );

    let kept = pass.kept;
    let dropped = [...preDropped, ...pass.dropped];
    let gateUsage: VerifyUsage = ZERO_VERIFY_USAGE;

    // Per-finding verifier verdict (carries the verifier's investigation tool
    // calls) so we can attribute per-finding verifier evidence to the trace.
    const verdictByFinding = new Map<FinderSuggestion, Verdict>();
    pass.kept.forEach((f, i) => verdictByFinding.set(f, pass.keptVerdicts[i]));
    pass.dropped.forEach((d) => verdictByFinding.set(d.candidate, d.verdict));
    preDropped.forEach((d) => verdictByFinding.set(d.candidate, d.verdict));

    // EVIDENCE GATE (ported from legacy): a finding kept WITHOUT the finder
    // having investigated its file is not trusted blindly — it gets a thorough
    // FULL re-verify, which may then drop it.
    const unevidenced = kept.filter(
        (f) => !fileWasInvestigated(investigated, f.relevantFile),
    );
    if (unevidenced.length > 0) {
        const fullVerifier = new LlmVerifier(params.runner, {
            modelId: params.modelId,
            fallbackModelId: params.fallbackModelId,
            tools: params.tools,
            forceFull: true,
            providerOptions: params.providerOptions,
            telemetryMetadata: params.telemetryMetadata,
            agentName: params.agentName,
            usageRunName: params.usageRunName,
            previousDecisions: params.previousDecisions,
            repoInstructions: params.repoInstructions,
            laneFocus: params.laneFocus,
        });
        const gate = await runVerificationPass<FinderSuggestion>(
            {
                candidates: unevidenced,
                verifier: fullVerifier,
                concurrency: params.concurrency,
            },
            ctx,
        );
        // The gate's re-verify is the more thorough look — its verdict (and tool
        // evidence) supersedes the first pass for the re-checked findings.
        gate.kept.forEach((f, i) =>
            verdictByFinding.set(f, gate.keptVerdicts[i]),
        );
        gate.dropped.forEach((d) =>
            verdictByFinding.set(d.candidate, d.verdict),
        );
        const stillDropped = new Set(gate.dropped.map((d) => d.candidate));
        kept = kept.filter((f) => !stillDropped.has(f));
        dropped = [...dropped, ...gate.dropped];
        gateUsage = { ...fullVerifier.usage };
    }

    // A repo_instruction finding must quote the instructions merged on the
    // target branch. The verifier is told so but does not always hold to it
    // (it kept quotes of a rule the PR itself adds to CLAUDE.md), so the quote
    // is checked here.
    const unquoted = kept.filter(
        (f) =>
            f.label === 'repo_instruction' &&
            !quotesRepoInstruction(
                f.suggestionContent,
                params.repoInstructions,
            ),
    );
    if (unquoted.length > 0) {
        const unquotedSet = new Set(unquoted);
        kept = kept.filter((f) => !unquotedSet.has(f));
        dropped = [
            ...dropped,
            ...unquoted.map((candidate) => {
                const verdict: Verdict = {
                    ...verdictByFinding.get(candidate),
                    keep: false,
                    rationale:
                        'The quoted instruction is not in the target-branch instruction files.',
                };
                verdictByFinding.set(candidate, verdict);
                return { candidate, verdict };
            }),
        ];
        finderLogger.log({
            message: `Dropped ${unquoted.length} repo_instruction finding(s) whose quote is not in the target-branch instructions`,
            context: 'finder.repo-instruction-quote',
            metadata: {
                ...params.telemetryMetadata,
                agentName: params.agentName,
                files: unquoted.map((f) => f.relevantFile),
            },
        });
    }

    return {
        kept,
        dropped,
        verdictByFinding,
        verifyUsage: sumVerifyUsage(verifier.usage, gateUsage),
    };
}

/** Split candidates for the second pass: bug findings → HV2; convention
 *  findings proven by an ast-grep match → kept without a judge; the other
 *  convention findings → quote check, whose survivors go to the convention
 *  verifier with their guide section and whose failures are dropped. */
async function routeByKind(
    suggestions: FinderSuggestion[],
    check: ConventionCheckParams,
    logContext: Record<string, unknown> = {},
): Promise<{
    bugs: FinderSuggestion[];
    proven: FinderSuggestion[];
    conventions: FinderSuggestion[];
    sectionOf: Map<FinderSuggestion, string>;
    rejected: ConventionCheckRejected[];
}> {
    // A "convention" sourced from a tool's output (e.g. a CLI) quotes no
    // rule, so the quote gate would drop it: it is checked as a bug instead.
    const toolSourced = suggestions.filter(
        (s) => s.kind === 'convention' && isToolSource(s, check.guideFiles),
    );
    const bugs = [
        ...suggestions.filter((s) => s.kind !== 'convention'),
        ...toolSourced.map((s) => ({
            ...s,
            kind: 'bug' as const,
            source: undefined,
        })),
    ];
    const candidates = suggestions.filter(
        (s) => s.kind === 'convention' && !isToolSource(s, check.guideFiles),
    );
    if (candidates.length === 0) {
        return {
            bugs,
            proven: [],
            conventions: [],
            sectionOf: new Map(),
            rejected: [],
        };
    }
    const astGrepOutputs = check.astGrepLog?.outputs ?? [];
    const proven = candidates.filter((s) =>
        isProvenByAstGrep(s, astGrepOutputs),
    );
    const provenSet = new Set(proven);
    const quoted = await checkConventionQuotes(
        candidates.filter((s) => !provenSet.has(s)),
        check.readGuide,
        check.guideFiles ?? [],
        check.listGuideDir,
        check.teamInstructions,
    );
    if (quoted.rejected.length > 0) {
        finderLogger.log({
            message: `[quote-check] dropped ${quoted.rejected.length} convention finding(s) whose quote is not in the guide on the target branch`,
            context: 'finder',
            serviceName: 'finder',
            metadata: {
                ...logContext,
                // Counts by why: the detail names the guide, never the quote.
                byReason: quoted.rejected.reduce<Record<string, number>>(
                    (counts, r) => {
                        const why = quoteRejectReason(r.detail);
                        counts[why] = (counts[why] ?? 0) + 1;
                        return counts;
                    },
                    {},
                ),
                rejected: quoted.rejected.map((r) => ({
                    file: r.finding.relevantFile,
                    guide: r.finding.source?.file,
                    detail: r.detail,
                })),
            },
        });
    }
    return {
        bugs,
        proven,
        conventions: quoted.passed.map((p) => p.finding),
        sectionOf: new Map(
            quoted.passed.map((p) => [p.finding, p.sectionText]),
        ),
        rejected: quoted.rejected,
    };
}

/** A quote-check rejection's detail without the guide's path, so the log
 *  counts rejections by why. */
function quoteRejectReason(detail: string): string {
    if (detail.startsWith('quote not found in ')) return 'quote not in guide';
    if (detail.endsWith(' is not a guide linked to this review'))
        return 'guide not linked';
    if (detail.endsWith(' not found on the target branch'))
        return 'guide not on target branch';
    if (detail.startsWith('could not list the files of '))
        return 'skill files not listable';
    return detail;
}

/** Files the finder actually investigated via readFile/checkTypes — the "strong
 *  evidence" the evidence gate checks. (grep is excluded: a search doesn't prove
 *  the agent read the matched code, matching the legacy strongFiles notion.) */
export function strongFilesFromRun(state: RunState): Set<string> {
    const out = new Set<string>();
    for (const step of state.steps) {
        for (const tc of step.message.toolCalls ?? []) {
            if (tc.name !== 'readFile' && tc.name !== 'checkTypes') {
                continue;
            }
            const input = tc.input as Record<string, unknown> | undefined;
            const p =
                (input?.path as string) ??
                (input?.filePath as string) ??
                (input?.file as string);

            if (typeof p === 'string' && p) {
                out.add(normalizePath(p));
            }
        }
    }
    return out;
}

export function normalizePath(p: string): string {
    // The finding type declares relevantFile as string, but LLM output
    // (observed with kimi-k2.7) sometimes omits it; an undefined here
    // crashed the whole finder run ("Completed with Warnings", agent
    // dropped, minutes of work lost).
    if (typeof p !== 'string' || !p) return '';
    return p
        .replace(/\\/g, '/')
        .replace(/^\.?\/+/, '')
        .toLowerCase();
}

export function fileWasInvestigated(
    investigated: Set<string>,
    file: string,
): boolean {
    // A finding without a file can't claim investigation evidence.
    if (!file) return false;
    const f = normalizePath(file);
    for (const s of investigated) {
        if (s === f || s.endsWith('/' + f) || f.endsWith('/' + s)) {
            return true;
        }
    }
    return false;
}

function sumVerifyUsage(a: VerifyUsage, b: VerifyUsage): VerifyUsage {
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        reasoningTokens: a.reasoningTokens + b.reasoningTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    };
}

// ─── Recall pass (synthesis rescue) ──────────────────────────────────────────
// After the main finder pass, one extra synthesis-rescue run re-thinks from the
// evidence already gathered and surfaces concrete MISSED bugs, dedup-merged
// before verify. (Soft coverage: the legacy coverage-recovery + 2nd/3rd-chance
// passes were removed — no coverage-forced re-runs.) Skipped in fast/trial mode.

type FinderFindings = { reasoning: string; suggestions: FinderSuggestion[] };

interface RecallPassesParams {
    runner: AgentRunner;
    finderSpec: AgentSpec;
    finderState: RunState;
    /** The original review prompt — reused by the synthesis-rescue pass. */
    userPrompt: string;
    skipHeavyPasses?: boolean;
    skipSynthesisRescue?: boolean;
    telemetryMetadata?: LangfuseTelemetryMetadata;
    /** The finder's model id, for the findings parse logs (#2112). */
    modelId?: string;
    agentName?: string;
    /** Injected prose-findings recovery (see ProseRecoverer). */
    recoverProse?: ProseRecoverer;
    /** Guides linked to a custom agent: the synthesis rescue also asks for
     *  missed violations of them, not only missed bugs. */
    conventionGuides?: string[];
    /** A custom agent's team system (MCP) tools: the synthesis rescue also
     *  asks whether one it consulted states a requirement the change breaks.
     *  Unset or empty for every other agent, whose prompt stays unchanged. */
    teamSystemTools?: string[];
    /** A custom agent kept to its lane: the synthesis rescue asks for missed
     *  findings within its focus instead of missed bugs. Unset for every
     *  other agent, whose prompt stays unchanged. */
    laneScoped?: boolean;
}

const ZERO_RECALL_USAGE: VerifyUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
};

/** How many NEW findings each extra pass contributed. Without this, a pass that
 *  costs a full finder run and adds nothing is indistinguishable from one that
 *  carries the whole gain — the merged total looks the same either way. */
export interface RecallPassStat {
    label: string;
    added: number;
    /** Steps the pass ran before finalizing — what a maxSteps cap actually
     *  bounds. A step can issue multiple tool calls at once, so this is NOT
     *  derivable from toolCalls. */
    steps: number;
    /** Tool calls the pass made. Zero means it answered without investigating. */
    toolCalls: number;
    /** Wall clock of the pass. */
    ms?: number;
    /** Output and reasoning tokens of the pass (#1821: cost per pass). */
    outputTokens?: number;
    reasoningTokens?: number;
    /** Start, in epoch ms. `startMs` is relative to the start of its own block
     *  of passes; only the absolute value compares passes across blocks. */
    startEpochMs?: number;
    /** When the pass STARTED, in ms since the start of its block. With `ms`
     *  this gives the timeline: which passes overlap and how long the block
     *  took in wall clock. */
    startMs?: number;
    /** Range-less readFile calls — the whole-file reads. */
    fullFileReads: number;
    /** Prompt-cache diagnostic: this pass's own inputTokens/cacheReadTokens.
     *  A recall pass prepends the SAME userPrompt (diff + rules) as the base
     *  pass — if the provider caches that shared prefix, cacheReadTokens
     *  should be close to inputTokens. If it stays near 0, the prefix is
     *  being paid for fresh every time. */
    inputTokens: number;
    cacheReadTokens: number;
}

export async function runRecallPasses(
    base: FinderFindings,
    params: RecallPassesParams,
    ctx: ToolContext,
): Promise<{
    findings: FinderFindings;
    usage: VerifyUsage;
    passStats: RecallPassStat[];
    /** Files the recall passes opened with readFile/checkTypes. The evidence
     *  gate only saw the base pass's reads, so a recall finding on a file the
     *  pass itself read still got the full re-verify as "uninvestigated". */
    investigatedFiles?: Set<string>;
}> {
    let findings = base;
    const investigatedFiles = new Set<string>();
    let usage = ZERO_RECALL_USAGE;
    // Time zero of the timeline: every `startMs` is relative to it, so the
    // numbers compare across PRs and runs without carrying epochs.
    const FINDER_T0 = Date.now();
    const passStats: RecallPassStat[] = [];
    if (params.skipHeavyPasses) {
        return { findings, usage, passStats, investigatedFiles };
    }

    const toolCalls = collectToolCalls(params.finderState);
    // Re-run the finder with a focused prompt; merge its ADDITIONAL findings.
    // `label` names the observation so each pass is distinct in the trace.
    const runPass = async (prompt: string, label: string): Promise<void> => {
        // Wall clock per pass. Tokens do not answer "why was this review
        // slow": a cheap pass that waits 90s on the provider costs the same
        // tokens as one that takes 9s, and only one of them is the bottleneck.
        const t0 = Date.now();
        const relativeStart = t0 - FINDER_T0;
        const state = await params.runner.run(
            params.finderSpec,
            {
                prompt,
                ...toAiSdkTelemetryArgs(
                    buildLangfuseTelemetry(
                        `${params.agentName ?? 'finder'}-${label}`,
                        params.telemetryMetadata,
                    ),
                ),
            },
            ctx,
        );
        const elapsedMs = Date.now() - t0;
        // Extract BEFORE touching the shared accumulators, then merge
        // synchronously (single-threaded, so the read-modify-write is atomic).
        const extracted = await extractFindingsWithRecovery(
            state,
            params.recoverProse,
            { ...params.telemetryMetadata, modelId: params.modelId },
        );
        const passUsage = usageOf(state.usage);
        usage = sumVerifyUsage(usage, passUsage);
        toolCalls.push(...collectToolCalls(state));
        for (const f of strongFilesFromRun(state)) investigatedFiles.add(f);
        // Which pass produced a finding is invisible downstream once the sets
        // merge; stamp it so precision can be read per pass.
        for (const sug of extracted.suggestions ?? []) {
            if (sug && !(sug as { producedBy?: string }).producedBy) {
                (sug as { producedBy?: string }).producedBy = label;
            }
        }
        const before = findings.suggestions.length;
        findings = mergeSuggestions(findings, extracted);
        const added = findings.suggestions.length - before;
        const passCalls = collectToolCalls(state);
        passStats.push({
            label,
            added,
            ms: elapsedMs,
            startMs: relativeStart,
            // Steps, not tool calls: a step can fire several tool calls at
            // once, so toolCalls alone can't confirm a maxSteps cap held —
            // this is the number ForceFinalizePolicy/maxSteps actually bounds.
            steps: state.steps.length,
            toolCalls: passCalls.length,
            fullFileReads: passCalls.filter(
                (c) =>
                    c.tool === 'readFile' &&
                    !(c.args as { startLine?: number })?.startLine,
            ).length,
            inputTokens: passUsage.inputTokens,
            cacheReadTokens: passUsage.cacheReadTokens,
            outputTokens: passUsage.outputTokens,
            reasoningTokens: passUsage.reasoningTokens,
            startEpochMs: t0,
        });
    };

    // Synthesis rescue — re-think from the evidence already gathered, surface
    // concrete MISSED bugs (no new variants/speculation). Always unless skipped.
    // Soft coverage: the coverage-recovery + 2nd/3rd-chance passes (and the
    // coverage-debt nudge) were removed — the main pass goes depth-first, with
    // no coverage-forced re-runs.
    if (!params.skipSynthesisRescue) {
        const inspected = strongFilesFromRun(params.finderState);
        await runPass(
            buildSynthesisPrompt(
                params.userPrompt,
                inspected,
                toolCalls,
                findings.suggestions,
                params.conventionGuides,
                params.teamSystemTools,
                params.laneScoped,
            ),
            'synthesis-rescue',
        );
    }

    return { findings, usage, passStats, investigatedFiles };
}

/** Dedup-merge extra findings into the base set (ported from legacy
 *  mergeFindings): key = file::startLine::endLine::content. */
function mergeSuggestions(
    baseF: FinderFindings,
    extraF: FinderFindings,
): FinderFindings {
    const keyOf = (s: FinderSuggestion) =>
        [
            s.relevantFile,
            s.relevantLinesStart ?? '',
            s.relevantLinesEnd ?? '',
            s.suggestionContent,
        ].join('::');
    const seen = new Set(baseF.suggestions.map(keyOf));
    const additions = extraF.suggestions.filter((s) => {
        const k = keyOf(s);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    return {
        reasoning: [baseF.reasoning, extraF.reasoning]
            .filter(Boolean)
            .join('\n\n'),
        suggestions: [...baseF.suggestions, ...additions],
    };
}

function collectToolCalls(
    state: RunState,
): Array<{ tool: string; args: unknown }> {
    return state.steps.flatMap((s) =>
        (s.message.toolCalls ?? []).map((tc) => ({
            tool: tc.name,
            args: tc.input ?? {},
        })),
    );
}

function usageOf(u: TokenUsage | undefined): VerifyUsage {
    return {
        inputTokens: u?.inputTokens ?? 0,
        outputTokens: u?.outputTokens ?? 0,
        reasoningTokens: u?.reasoningTokens ?? 0,
        cacheReadTokens: u?.cacheReadTokens ?? 0,
    };
}

function investigationSummary(
    toolCalls: Array<{ tool: string; args: unknown }>,
): string {
    return toolCalls
        .slice(-20)
        .map((tc) => {
            const args =
                typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args);
            return `${tc.tool}(${(args ?? '').substring(0, 150)})`;
        })
        .join('\n');
}

function buildSynthesisPrompt(
    userPrompt: string,
    inspected: Set<string>,
    toolCalls: Array<{ tool: string; args: unknown }>,
    current: FinderSuggestion[],
    conventionGuides?: string[],
    teamSystemTools?: string[],
    laneScoped?: boolean,
): string {
    const inspectedList = inspected.size
        ? [...inspected].join('\n')
        : 'No files recorded as inspected.';
    const currentSummary = current.length
        ? current
              .map(
                  (s) =>
                      `- ${s.relevantFile}: ${s.suggestionContent.substring(0, 120)}`,
              )
              .join('\n')
        : 'No findings reported yet.';
    return `${userPrompt}

<AlreadyInspectedFiles>
${inspectedList}
</AlreadyInspectedFiles>

<RecentInvestigation>
${investigationSummary(toolCalls) || 'No tool calls captured.'}
</RecentInvestigation>

<CurrentFindings>
${currentSummary}
</CurrentFindings>

${laneScoped ? LANE_SYNTHESIS_TASK : SYNTHESIS_TASK}${formatMissedConventionsTask(conventionGuides)}${formatTeamSystemsTask(teamSystemTools, toolCalls)}`;
}

const SYNTHESIS_TASK = `Your task:
- Re-think the review based on the context above.
- Do not add variants or restatements of existing findings.
- Do not add speculative risks.
- If there are concrete missed bugs, submit them.
- If there is no clearly missed bug, submit an empty suggestions array.`;

/** The rescue of a custom agent kept to its lane: re-thinking for missed bugs
 *  would re-do the generalist's hunt (#2172). */
const LANE_SYNTHESIS_TASK = `Your task:
- Re-think the review based on the context above, within your focus (the team's instructions, guides, skills and tools in your system prompt).
- Do not add variants or restatements of existing findings.
- Do not add speculative risks, and do not add general bugs outside your focus: the generalist reviewer covers them.
- If there are concrete missed findings within your focus, submit them.
- If there is none, submit an empty suggestions array.`;

/** Custom agents with team system (MCP) tools: the rescue also asks whether a
 *  record they read states a requirement the change breaks. The finder only
 *  reports what it sees in the code, so a requirement the code never mentions
 *  was left out (#2172). Empty for every other agent, so their rescue prompt
 *  is unchanged. */
function formatTeamSystemsTask(
    teamSystemTools: string[] | undefined,
    toolCalls: Array<{ tool: string; args: unknown }>,
): string {
    if (!teamSystemTools?.length) return '';
    const names = new Set(teamSystemTools);
    const consulted = toolCalls
        .filter((tc) => names.has(tc.tool))
        .map((tc) => `- ${investigationSummary([tc])}`);
    return `

<ConsultedTeamSystems>
${[...new Set(consulted)].join('\n') || 'None yet.'}
</ConsultedTeamSystems>

Did a team system you consulted state a requirement this change breaks?
- Check what those records require (a ticket's acceptance criteria, a recorded decision, an incident's follow-up) against the changed code. Call the tool again to re-read a record; the answer is kept for this review.
- A requirement the change contradicts or leaves out is a finding even when the code never mentions it. Report it on the changed code it concerns, and cite the record (system, id and the requirement's own words) as the evidence.
- A requirement that does not apply to this change is not a violation.`;
}

/** Custom agents with linked guides: the rescue also looks for rules of those
 *  guides the changed code breaks. Empty for every other agent, so their
 *  rescue prompt is unchanged. */
function formatMissedConventionsTask(guides?: string[]): string {
    if (!guides?.length) return '';
    return `

<LinkedGuides>
${guides.map((g) => `- ${g}`).join('\n')}
</LinkedGuides>

This agent also enforces the team guides above:
- Also look for MISSED VIOLATIONS of these guides in the changed code — a rule the change breaks that no current finding reports.
- For each, set kind "convention" and source { file, section, quote }, where file is the file you read the rule from (a skill's SKILL.md or the skill file you opened) and quote is the rule's exact sentence copied verbatim from it (read it with the tools; never paraphrase or invent a rule).
- A rule that does not cover this file or case is not a violation.`;
}
