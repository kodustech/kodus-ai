import { RUN_PLAN_PATH, type RunPlanRequest, type RunPlanResponse, RunPlanResponseSchema } from '@libs/runtime/contracts/run-plan';

import { type CanaryVault, CanaryLeakError, containsCanary } from '../canary/canary';
import type { SecretOpener } from '../secrets/sealed-tokens';
import type { FetchLike } from './http-llm-gateway';
import { LlmBudgetExceededError, LlmUnavailableError } from './llm-gateway';

export interface RunPlanCall {
    runId: string;
    attempt?: number;
    signal?: AbortSignal;
    organizationId: string;
    /** Sealed to the Run. */
    runToken: string;
    body: RunPlanRequest;
}

/** One round of the product's test planner (ADR-069). */
export interface RunPlanClient {
    /** Throws LlmBudgetExceededError, LlmUnavailableError or CanaryLeakError: the Run handles them as any LLM call's. */
    plan(call: RunPlanCall): Promise<RunPlanResponse>;
}

/**
 * POST /internal/runtime/plan with the Run token (ADR-057, ADR-069): the
 * planner runs in the product with the org's key, which never reaches the
 * worker. The token arrives sealed to the Run and is opened here, inside the
 * step that makes the call; it travels only in the Authorization header.
 */
export class HttpRunPlanClient implements RunPlanClient {
    private readonly url: string;

    constructor(
        baseUrl: string,
        private readonly opts: { secrets: SecretOpener; fetch?: FetchLike; timeoutMs?: number },
    ) {
        this.url = `${baseUrl.replace(/\/+$/, '')}/${RUN_PLAN_PATH}`;
    }

    async plan(call: RunPlanCall): Promise<RunPlanResponse> {
        if (!call.runToken) throw new LlmUnavailableError('missing run token');
        let token: string;
        try {
            token = this.opts.secrets.open(call.runToken, call.runId);
        } catch {
            throw new LlmUnavailableError('the run token does not open for this Run');
        }
        const doFetch = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
        let res: Awaited<ReturnType<FetchLike>>;
        try {
            res = await doFetch(this.url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify(call.body),
                signal: AbortSignal.timeout(this.opts.timeoutMs ?? 300_000),
            });
        } catch (e) {
            throw new LlmUnavailableError(`the test planner did not answer (${e instanceof Error ? e.name : 'error'})`);
        }
        const body = await res.json().catch(() => undefined);
        if (res.status === 429 && body?.code === 'llm_budget_exceeded') throw new LlmBudgetExceededError(`run ${call.runId} exhausted the ${body?.scope ?? 'run'} LLM budget`);
        if (!res.ok) throw new LlmUnavailableError(`the test planner answered ${res.status}`);
        // apps/api's TransformInterceptor wraps every success as { statusCode, type, data }.
        const out = body && typeof body === 'object' && 'data' in body && typeof body.data === 'object' ? body.data : body;
        const parsed = RunPlanResponseSchema.safeParse(out);
        if (!parsed.success) throw new LlmUnavailableError('the test planner answered something that is not a plan');
        return parsed.data;
    }
}

/**
 * Every round's body is checked for the Run's canaries before it leaves
 * (ADR-043), as every LLM prompt is: command output from the base machine
 * goes back to the model in it.
 */
export class CanaryGuardedRunPlanClient implements RunPlanClient {
    constructor(
        private readonly inner: RunPlanClient,
        private readonly vault: CanaryVault,
    ) {}

    async plan(call: RunPlanCall): Promise<RunPlanResponse> {
        if (containsCanary(JSON.stringify(call.body), this.vault.forRun(call))) throw new CanaryLeakError('llm_prompt');
        return this.inner.plan(call);
    }
}
