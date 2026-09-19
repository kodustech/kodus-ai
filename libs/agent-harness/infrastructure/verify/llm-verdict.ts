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
 *
 * TEXT VERDICTS (issue #1937): a model that answers in text instead of calling
 * the verdict tool used to hit that fail-open default, so every refutation it
 * wrote as prose was discarded and the candidate published. `verdictFromText`
 * reads the final step's text deterministically (no extra model call) before the
 * default applies.
 */
import type { AgentSpec } from '../../domain/contracts/agent.contract';
import type { JSONSchema } from '../../domain/contracts/json-schema.contract';
import type { RunState } from '../../domain/contracts/run-state.contract';
import type { AgentPolicy } from '../../domain/contracts/policy.contract';
import type { ToolRegistry } from '../../domain/contracts/tool.contract';
import type { Verdict } from '../../domain/contracts/verifier.contract';
import { InMemoryToolRegistry } from '../tools/in-memory-tool-registry';
import {
    extractLastJsonObjectWith,
    normalizeEnvelope,
} from '@libs/llm/structured-output-repair';

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
        tools,
        policies: params.policies ?? [],
        maxSteps: params.maxSteps ?? 6,
        // The runner materializes submitVerdict's payload into RunState.artifacts;
        // extractVerdict reads that, never re-scanning steps.
        resultToolName: VERIFY_DONE_TOOL,
        ...(params.providerOptions
            ? { providerOptions: params.providerOptions }
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

/** Aliases a non-strict model renames `keep` to. Shared by the artifact (shape
 *  recovery) and the text paths so both recognise the same verdict. */
export const VERDICT_KEEP_ALIASES = [
    'decision',
    'verdict',
    'shouldKeep',
] as const;

/** Read `{keep, rationale, confidence}` off a verdict object that is ALREADY in
 *  canonical shape (top-level boolean `keep`). Returns null otherwise — the
 *  caller then falls through to its next source. No shape recovery: see
 *  {@link recoverVerdictObject}. */
export function readVerdictObject(
    value: unknown,
): Omit<Verdict, 'toolCalls' | 'parseMode'> | null {
    if (
        !value ||
        typeof value !== 'object' ||
        typeof (value as Record<string, unknown>).keep !== 'boolean'
    ) {
        return null;
    }
    const obj = value as Record<string, unknown>;
    return {
        keep: obj.keep as boolean,
        rationale:
            typeof obj.rationale === 'string' ? obj.rationale : undefined,
        confidence: obj.confidence as Verdict['confidence'],
    };
}

/** {@link readVerdictObject} preceded by SHAPE recovery (#1786): a non-strict
 *  model may wrap ({result:{keep}}), rename (decision/verdict/shouldKeep),
 *  stringify or bare-array the verdict. Used where that recovery is already the
 *  contract — code-review's artifact path — and by the text fallback, whose
 *  input is raw model output by definition. */
export function recoverVerdictObject(
    value: unknown,
    onRecover?: (reason: string) => void,
): Omit<Verdict, 'toolCalls' | 'parseMode'> | null {
    return readVerdictObject(
        normalizeEnvelope(value, 'keep', [...VERDICT_KEEP_ALIASES], {
            scalar: true,
            ...(onRecover ? { onRecover } : {}),
        }),
    );
}

/** Recover a verdict the model wrote as TEXT instead of calling the verdict tool
 *  (issue #1937). Deterministic — no extra model call.
 *
 *  Reads the FINAL step only: an earlier step's JSON is the model thinking out
 *  loud before it investigated, not its answer. Within that step it takes the
 *  LAST object carrying `keep`, so a quoted code block or an example above the
 *  verdict cannot be mistaken for it. */
export function verdictFromText(
    state: RunState,
    onRecover?: (reason: string) => void,
): Omit<Verdict, 'toolCalls' | 'parseMode'> | null {
    const last = state.steps[state.steps.length - 1];
    const text = last?.message.content;
    if (typeof text !== 'string' || !text.trim()) return null;
    const obj = extractLastJsonObjectWith(text, [
        'keep',
        ...VERDICT_KEEP_ALIASES,
    ]);
    if (!obj) return null;
    return recoverVerdictObject(obj, onRecover);
}

/** Extract the Verdict from a verifier run: the materialized artifact first, then
 *  the final step's text (issue #1937), then fail open.
 *  Fail-open: default keep=true (only an explicit keep:false drops the candidate). */
export function extractVerdict(state: RunState): Verdict {
    const toolCalls = collectVerifierToolCalls(state);
    for (let i = state.artifacts.length - 1; i >= 0; i--) {
        const artifact = state.artifacts[i];
        if (artifact.type !== VERIFY_DONE_TOOL) continue;
        const fromTool = readVerdictObject(artifact.payload);
        if (fromTool) {
            return { ...fromTool, toolCalls, parseMode: 'tool' };
        }
    }
    const fromText = verdictFromText(state);
    if (fromText) {
        return { ...fromText, toolCalls, parseMode: 'text' };
    }
    return {
        keep: true,
        rationale: 'no parseable verdict — kept by default',
        toolCalls,
        parseMode: 'default-keep',
    };
}
