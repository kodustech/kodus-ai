/**
 * The doctor's test of the SDK path (CSDK-14): one request through the real
 * subprocess and gateway, with no fallback, reporting each hop on its own —
 * the binary started, the gateway took the request, the provider answered.
 */
import type { SdkProbeResult } from '@libs/llm/sdk-executor-registry';
import type { NormalizedModel } from '@libs/llm/byok-config';

import { resolveClaudeSdkRoute } from './eligibility';
import type { ClaudeSdkDeps } from './sdk-loop-call';

export async function probeClaudeSdk(deps: ClaudeSdkDeps, params: { slot: NormalizedModel | undefined; organizationId?: string; timeoutMs: number }): Promise<SdkProbeResult> {
    const resolved = resolveClaudeSdkRoute(params.slot);
    const notReached = { ok: false, error: 'not reached' };
    if (!resolved) return { spawn: { ok: false, error: 'this model does not run on the Claude Agent SDK' }, gateway: notReached, upstream: notReached };
    const signal = AbortSignal.timeout(params.timeoutMs);
    let started = false;
    let result: any;
    let thrown: unknown;
    let snapshot: { requests: Array<{ status: number }>; upstreamErrors: Array<{ status: number; body: string }> } | undefined;
    let localError: Error | undefined;
    try {
        await deps.pool.withSession(
            { resolved, envelope: { slot: params.slot, organizationId: params.organizationId, provider: params.slot?.provider }, signal },
            async (session) => {
                const runtime = deps.runtime();
                try {
                    for await (const m of runtime.query({
                        prompt: 'Reply with the single word OK.',
                        options: {
                            model: session.model,
                            systemPrompt: 'You are a health check.',
                            tools: [],
                            settingSources: [],
                            persistSession: false,
                            cwd: session.home,
                            env: session.env,
                            maxTurns: 1,
                            abortController: session.abortController,
                            spawnClaudeCodeProcess: (o: any) => {
                                const child = session.spawn(o);
                                child.once('spawn', () => (started = true));
                                return child;
                            },
                        },
                    })) {
                        if (m.type === 'system' && m.subtype === 'init') started = true;
                        if (m.type === 'result') result = m;
                    }
                } catch (err) {
                    thrown = err;
                }
                snapshot = session.gateway.ledger.snapshot();
                localError = session.gateway.localErrors[session.gateway.localErrors.length - 1];
            },
        );
    } catch (err) {
        thrown ??= err;
    }

    const text = (e: unknown) => String((e as Error)?.message ?? e ?? '').slice(0, 300);
    const spawn = started ? { ok: true } : { ok: false, error: text(thrown) || 'the Claude Agent SDK binary did not start' };
    if (!spawn.ok) return { spawn, gateway: notReached, upstream: notReached };
    const requests = snapshot?.requests.length ?? 0;
    if (localError) return { spawn, gateway: { ok: false, error: text(localError) }, upstream: notReached };
    if (!requests) return { spawn, gateway: { ok: false, error: text(thrown) || String(result?.result ?? 'no request reached the gateway') }, upstream: notReached };
    const upstreamError = snapshot!.upstreamErrors[snapshot!.upstreamErrors.length - 1];
    if (upstreamError) return { spawn, gateway: { ok: true }, upstream: { ok: false, status: upstreamError.status, error: upstreamError.body.slice(0, 300) } };
    if (!result || result.is_error) return { spawn, gateway: { ok: true }, upstream: { ok: false, error: text(thrown) || String(result?.result ?? 'no answer') } };
    return { spawn, gateway: { ok: true }, upstream: { ok: true, status: snapshot!.requests[snapshot!.requests.length - 1]?.status } };
}
