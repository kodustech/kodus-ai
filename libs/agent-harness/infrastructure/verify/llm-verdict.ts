/**
 * agent-harness — generic LLM-verdict scaffolding (the doer≠checker building
 * blocks, prompt-agnostic).
 *
 * A verifier is an agent run whose ONLY job is to emit a structured Verdict for
 * one candidate via the `submitVerdict` result tool. This module owns the
 * reusable parts — the verdict tool/schema, the spec builder, and the fail-open
 * extractor — so any domain (code-review findings, business-rules results, ...)
 * builds a Verifier by supplying its own system prompt + candidate→prompt
 * mapping, instead of re-hand-rolling the verdict plumbing.
 *
 * Refute-to-drop / fail-open: `extractVerdict` defaults to keep=true. A verifier
 * that errors, times out, or returns nothing NEVER silently drops a candidate —
 * only an explicit `keep:false` does.
 */
import type { AgentSpec } from '../../domain/contracts/agent.contract';
import type { JSONSchema } from '../../domain/contracts/json-schema.contract';
import type { RunState } from '../../domain/contracts/run-state.contract';
import type { AgentPolicy } from '../../domain/contracts/policy.contract';
import type { ToolRegistry } from '../../domain/contracts/tool.contract';
import type { Verdict } from '../../domain/contracts/verifier.contract';
import { InMemoryToolRegistry } from '../tools/in-memory-tool-registry';

/** The result tool a verifier run must call to emit its verdict. */
export const VERIFY_DONE_TOOL = 'submitVerdict' as const;

export const VERDICT_SCHEMA: JSONSchema = {
    type: 'object',
    properties: {
        keep: { type: 'boolean' },
        rationale: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['keep', 'rationale'],
};

export const submitVerdictTool = {
    name: VERIFY_DONE_TOOL,
    description:
        'Submit your verdict for the candidate (keep=true unless you can REFUTE it).',
    inputSchema: VERDICT_SCHEMA,
    execute: async () => ({ output: 'verdict recorded' }),
};

export interface BuildVerifierAgentSpecParams {
    /** Spec id (trace label). Defaults to 'verifier'. */
    id?: string;
    /** The verifier's system prompt — the domain's "how to judge" instructions. */
    systemPrompt: string;
    modelId: string;
    /** Investigation tools the verifier may use (grep/readFile/...). The verdict
     *  tool is appended automatically. */
    tools: ToolRegistry;
    maxSteps?: number;
    /** Extra policies (e.g. BudgetPolicy). The verdict capture is wired via
     *  resultToolName regardless. */
    policies?: readonly AgentPolicy[];
    providerOptions?: Readonly<Record<string, unknown>>;
    systemProviderOptions?: Readonly<Record<string, unknown>>;
}

/** Build a verifier AgentSpec: the domain's prompt + tools + the verdict result
 *  tool, captured into RunState.artifacts via resultToolName. */
export function buildVerifierAgentSpec(
    params: BuildVerifierAgentSpecParams,
): AgentSpec {
    const tools = new InMemoryToolRegistry([
        ...params.tools.list(),
        submitVerdictTool,
    ]);
    return {
        id: params.id ?? 'verifier',
        systemPrompt: params.systemPrompt,
        modelId: params.modelId,
        tools,
        policies: params.policies ?? [],
        maxSteps: params.maxSteps ?? 6,
        // The runner materializes submitVerdict's payload into RunState.artifacts;
        // extractVerdict reads that, never re-scanning steps.
        resultToolName: VERIFY_DONE_TOOL,
        ...(params.providerOptions
            ? { providerOptions: params.providerOptions }
            : {}),
        ...(params.systemProviderOptions
            ? { systemProviderOptions: params.systemProviderOptions }
            : {}),
    };
}

/** Flatten the verifier run's investigation tool calls into the generic
 *  Verdict.toolCalls shape (name/args/result). Excludes the verdict tool. */
export function collectVerifierToolCalls(state: RunState): Verdict['toolCalls'] {
    const out: Array<{
        name: string;
        args?: Record<string, unknown>;
        result?: string;
    }> = [];
    for (const step of state.steps) {
        for (const tc of step.message.toolCalls ?? []) {
            if (tc.name === VERIFY_DONE_TOOL) continue;
            out.push({
                name: tc.name,
                args:
                    tc.input && typeof tc.input === 'object'
                        ? (tc.input as Record<string, unknown>)
                        : undefined,
                result: tc.output,
            });
        }
    }
    return out;
}

/** Extract the Verdict from a verifier run by reading its materialized artifacts.
 *  Fail-open: default keep=true (only an explicit keep:false drops the candidate). */
export function extractVerdict(state: RunState): Verdict {
    const toolCalls = collectVerifierToolCalls(state);
    for (let i = state.artifacts.length - 1; i >= 0; i--) {
        const artifact = state.artifacts[i];
        if (artifact.type !== VERIFY_DONE_TOOL) continue;
        const parsed = artifact.payload;
        if (
            parsed &&
            typeof parsed === 'object' &&
            typeof (parsed as Record<string, unknown>).keep === 'boolean'
        ) {
            const obj = parsed as Record<string, unknown>;
            return {
                keep: obj.keep as boolean,
                rationale: obj.rationale as string | undefined,
                confidence: obj.confidence as Verdict['confidence'],
                toolCalls,
            };
        }
    }
    return {
        keep: true,
        rationale: 'no parseable verdict — kept by default',
        toolCalls,
    };
}
