import { RuntimeMetrics } from '@libs/runtime/telemetry';

import type { SecretOpener } from '../secrets/sealed-tokens';
import { LlmBudgetExceededError, LlmGateway, LlmRequest, LlmResponse, LlmUnavailableError } from './llm-gateway';
import { failureName, postToProduct, unwrapProductBody } from './product-call';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
    status: number;
    ok: boolean;
    json(): Promise<any>;
}>;

/**
 * The real worker gateway (ADR-057): POSTs the turn to the product's
 * `/internal/runtime/llm` with the Run token. The product resolves the org's
 * BYOK, applies the budget and answers text + usage; the worker never holds an
 * LLM key. The Run token arrives sealed (bound to the Run) and is opened here,
 * inside the step that makes the call; it is sent only in the Authorization
 * header and never echoed in an error.
 */
export class HttpLlmGateway implements LlmGateway {
    private readonly url: string;

    constructor(
        baseUrl: string,
        private readonly opts: {
            secrets: SecretOpener;
            fetch?: FetchLike;
            metrics?: RuntimeMetrics;
            maxOutputTokens?: number;
            timeoutMs?: number;
            connectRetryDelaysMs?: readonly number[];
            sleep?: (ms: number) => Promise<void>;
        },
    ) {
        this.url = `${baseUrl.replace(/\/+$/, '')}/internal/runtime/llm`;
    }

    async complete(req: LlmRequest): Promise<LlmResponse> {
        if (!req.runToken) throw new LlmUnavailableError('missing run token');
        let runToken: string;
        try {
            runToken = this.opts.secrets.open(req.runToken, req.sealedFor ?? req.runId);
        } catch {
            throw new LlmUnavailableError('the run token does not open for this Run');
        }
        const doFetch = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
        // A turn the product never received (it was restarting) is sent again after a pause; one that may
        // have reached it is not: the product does not deduplicate turns, and may have run and billed it.
        let answer: Awaited<ReturnType<typeof postToProduct>>;
        try {
            answer = await postToProduct(
                doFetch,
                this.url,
                runToken,
                {
                    runId: req.runId,
                    task: req.task,
                    messages: req.messages,
                    ...((req.maxOutputTokens ?? this.opts.maxOutputTokens) ? { maxOutputTokens: req.maxOutputTokens ?? this.opts.maxOutputTokens } : {}),
                },
                { timeoutMs: this.opts.timeoutMs ?? 300_000, connectRetryDelaysMs: this.opts.connectRetryDelaysMs, sleep: this.opts.sleep },
            );
        } catch (e) {
            throw new LlmUnavailableError(`LLM gateway unreachable (${failureName(e)})`);
        }

        const { res, body } = answer;
        if (res.status === 429 && body?.code === 'llm_budget_exceeded') {
            this.opts.metrics?.recordLlmBudget(1, { orgId: req.organizationId, state: 'exhausted' });
            throw new LlmBudgetExceededError(`run ${req.runId} exhausted the ${body?.scope ?? 'run'} LLM budget`);
        }
        if (!res.ok) throw new LlmUnavailableError(`LLM gateway answered ${res.status}`);
        const out = unwrapProductBody(body) as any;
        if (typeof out?.text !== 'string') throw new LlmUnavailableError('LLM gateway answered without text');

        const usage = { inputTokens: Number(out.usage?.inputTokens ?? 0), outputTokens: Number(out.usage?.outputTokens ?? 0) };
        this.opts.metrics?.recordLlmTokens(usage, { orgId: req.organizationId, task: req.task });
        const remaining = out.budget?.remaining;
        if (typeof remaining === 'number') {
            const spent = usage.inputTokens + usage.outputTokens;
            const fraction = spent + remaining > 0 ? 1 - remaining / (spent + remaining) : 1;
            this.opts.metrics?.recordLlmBudget(fraction, { orgId: req.organizationId, state: remaining <= 0 ? 'exhausted' : fraction >= 0.8 ? 'near_limit' : 'ok' });
        }
        return { text: out.text, usage };
    }
}
