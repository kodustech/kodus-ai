import type {
    ModelTurnRequest,
    ModelTurnResponse,
} from '@libs/runtime/contracts/model-turn';
import {
    MODEL_TURN_LIMITS,
    parseModelTurnRequest,
    parseModelTurnResponse,
} from '@libs/runtime/contracts/model-turn';
import { parseStrictJson } from '@libs/runtime/protocol/strict-json';
import { containsCanary, type CanaryVault } from '../canary/canary';
import { CanaryLeakError } from '../canary/canary';
import type { SecretOpener } from '../secrets/sealed-tokens';
import { LlmBudgetExceededError, LlmUnavailableError } from './llm-gateway';

export type RuntimeRpcFetch = (
    url: string,
    init: RequestInit,
) => Promise<Response>;
export interface WorkerModelTurnClient {
    complete(call: {
        runId: string;
        runToken: string;
        request: ModelTurnRequest;
        signal?: AbortSignal;
    }): Promise<ModelTurnResponse>;
}
/** Stream the bounded product response before JSON parsing; no unbounded res.json(). */
export async function readRuntimeRpc(
    response: Response,
    maxBytes: number,
): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader)
        throw new LlmUnavailableError('Runtime gateway returned no body');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > maxBytes)
                throw new LlmUnavailableError(
                    'Runtime gateway response is too large',
                );
            chunks.push(next.value);
        }
        try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(
                Buffer.concat(chunks),
            );
            return parseStrictJson(text, 32);
        } catch {
            throw new LlmUnavailableError(
                'Runtime gateway returned invalid JSON',
            );
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
}
export function rpcData(body: unknown): unknown {
    return body && typeof body === 'object' && 'data' in body
        ? (body as { data: unknown }).data
        : body;
}
export class HttpModelTurnClient implements WorkerModelTurnClient {
    constructor(
        private readonly baseUrl: string,
        private readonly opts: {
            secrets: SecretOpener;
            canaries: CanaryVault;
            fetch?: RuntimeRpcFetch;
            timeoutMs?: number;
        },
    ) {}
    async complete(
        call: Parameters<WorkerModelTurnClient['complete']>[0],
    ): Promise<ModelTurnResponse> {
        const request = parseModelTurnRequest(call.request);
        if (request.scope.runId !== call.runId)
            throw new LlmUnavailableError('Model turn scope mismatch');
        const bait = this.opts.canaries.forRun(call);
        if (containsCanary(JSON.stringify(request), bait))
            throw new CanaryLeakError('llm_prompt');
        let token: string;
        try {
            token = this.opts.secrets.open(call.runToken, call.runId);
        } catch {
            throw new LlmUnavailableError('Invalid Run context');
        }
        const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 120_000);
        const signal = call.signal
            ? AbortSignal.any([call.signal, timeout])
            : timeout;
        let response: Response;
        try {
            signal.throwIfAborted();
            response = await (this.opts.fetch ?? fetch)(
                `${this.baseUrl.replace(/\/+$/, '')}/internal/runtime/model-turn`,
                {
                    method: 'POST',
                    redirect: 'error',
                    headers: {
                        'content-type': 'application/json',
                        'authorization': `Bearer ${token}`,
                        'x-runtime-sealed-token': call.runToken,
                    },
                    body: JSON.stringify(request),
                    signal,
                },
            );
        } catch {
            if (call.signal?.aborted) throw call.signal.reason;
            throw new LlmUnavailableError('Runtime model gateway unavailable');
        }
        const body = await readRuntimeRpc(
            response,
            MODEL_TURN_LIMITS.responseBytes + 4096,
        );
        const error = body as { code?: string };
        if (response.status === 429 && error?.code === 'llm_budget_exceeded')
            throw new LlmBudgetExceededError('Runtime model budget exhausted');
        if (response.status === 403 && error?.code === 'canary_leak')
            throw new CanaryLeakError('llm_prompt');
        if (!response.ok)
            throw new LlmUnavailableError(
                `Runtime model gateway answered ${response.status}`,
            );
        const out = parseModelTurnResponse(rpcData(body), request);
        if (containsCanary(JSON.stringify(out), bait))
            throw new CanaryLeakError('llm_prompt');
        return out;
    }
}
