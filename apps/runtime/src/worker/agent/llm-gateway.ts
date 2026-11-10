import { RuntimeMetrics } from '@libs/runtime/telemetry';

// The runtime-worker never holds an LLM key (ADR-057): it calls the product's
// gateway with the Run token, and the gateway applies the budget. Here the
// gateway is a port; the only implementation in this PR replays recorded
// responses, so no real LLM is ever called.

export interface LlmMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface LlmRequest {
    runId: string;
    organizationId: string;
    runToken: string;
    /** What the sealed token is bound to when it is not the Run: a setup's learn loop seals it to the setup key. */
    sealedFor?: string;
    task: 'runtime.plan' | 'runtime.intent' | 'runtime.setup_learn';
    messages: LlmMessage[];
}

export interface LlmResponse {
    text: string;
    usage: { inputTokens: number; outputTokens: number; measurement?: 'partial' | 'unknown' };
}

export class LlmBudgetExceededError extends Error {
    readonly code = 'llm_budget_exceeded';
}

export class LlmUnavailableError extends Error {
    readonly code = 'llm_unavailable';
}

export interface LlmGateway {
    complete(req: LlmRequest): Promise<LlmResponse>;
}

export interface RecordedTurn {
    /** Each turn answers the n-th call of this task in the Run. */
    task: LlmRequest['task'];
    text: string;
    usage: LlmResponse['usage'];
}

/** Replays recorded responses in order, with a per-Run token budget. */
export class RecordedLlmGateway implements LlmGateway {
    private readonly used = new Map<string, number>();
    private readonly cursor = new Map<string, number>();

    constructor(
        private readonly turns: RecordedTurn[],
        private readonly opts: { maxTokensPerRun: number; metrics?: RuntimeMetrics },
    ) {}

    async complete(req: LlmRequest): Promise<LlmResponse> {
        if (!req.runToken) throw new LlmUnavailableError('missing run token');
        const spent = this.used.get(req.runId) ?? 0;
        if (spent >= this.opts.maxTokensPerRun) {
            this.opts.metrics?.recordLlmBudget(spent / this.opts.maxTokensPerRun, { orgId: req.organizationId, state: 'exhausted' });
            throw new LlmBudgetExceededError(`run ${req.runId} spent ${spent} tokens`);
        }
        const key = `${req.runId}:${req.task}`;
        const n = this.cursor.get(key) ?? 0;
        const turn = this.turns.filter((t) => t.task === req.task)[n];
        if (!turn) throw new LlmUnavailableError(`no recorded response #${n} for ${req.task}`);
        this.cursor.set(key, n + 1);
        const total = spent + turn.usage.inputTokens + turn.usage.outputTokens;
        this.used.set(req.runId, total);
        const fraction = total / this.opts.maxTokensPerRun;
        this.opts.metrics?.recordLlmBudget(fraction, {
            orgId: req.organizationId,
            state: fraction >= 1 ? 'exhausted' : fraction >= 0.8 ? 'near_limit' : 'ok',
        });
        return { text: turn.text, usage: turn.usage };
    }
}
