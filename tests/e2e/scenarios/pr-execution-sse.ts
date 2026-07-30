import type { RunContext, Scenario } from '../lib/types.js';
import { ensureLicenseSeat } from '../lib/onboarding.js';
import { logger } from '../lib/log.js';

const log = logger('pr-execution-sse');

// Cross-process event delivery, asserted end-to-end (the "class 1" family):
// PR execution updates are emitted by the review pipeline in the WORKER and
// consumed by the API's SSE endpoint (/pull-requests/executions/events).
// EventEmitter2 is per-process, so before the CrossProcessEventsBridge the
// stream only ever carried heartbeat pings on the split topology — the UI's
// live status never advanced, and nothing in the matrix noticed because no
// scenario ever LISTENED to the stream.
//
// This scenario opens a real PR (fixture branch pair, review fires) while
// holding an authenticated SSE connection, and requires at least one
// non-ping `execution_updated` frame to arrive. Heartbeats alone = FAIL.
const FIXTURE = { head: 'fixture/kody-rule-todo-remove-me', base: 'main' };

export const prExecutionSse: Scenario = {
    id: 'pr-execution-sse',
    title: "PR execution updates reach the API's SSE stream across processes",
    priority: 'P1',
    appliesTo: {
        target: ['cloud', 'self-hosted'],
        provider: ['github'],
        license: ['paid', 'license-paid'],
    },
    timeoutSec: 1200,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, 'scenario requires a tenant');
        if (!ctx.provider.openPRFromBranches) {
            throw new Error(
                `Provider ${ctx.provider.name} does not implement openPRFromBranches`,
            );
        }

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        // Start listening BEFORE the PR exists so no frame can be missed.
        const abort = new AbortController();
        const framesSeen: string[] = [];
        const gotExecutionUpdate = listenForExecutionUpdate({
            url: `${ctx.target.apiBaseUrl}/pull-requests/executions/events`,
            token: session.accessToken,
            signal: abort.signal,
            timeoutMs: 720_000,
            onFrame: (type) => framesSeen.push(type),
        });

        const opened = await ctx.provider.openPRFromBranches({
            head: FIXTURE.head,
            base: FIXTURE.base,
            title: `[e2e] pr-execution-sse ${ctx.runId.slice(-6)}`,
            body: `Automated PR opened by Kodus E2E run ${ctx.runId} to assert execution updates reach the SSE stream.`,
        });

        try {
            const received = await gotExecutionUpdate;
            ctx.assert(
                received,
                `No execution_updated frame arrived on the SSE stream while PR ${opened.url} was being reviewed — ` +
                    `only [${[...new Set(framesSeen)].join(', ')}] frames were seen. ` +
                    `The worker's execution updates are not crossing into the API process (CrossProcessEventsBridge regression).`,
            );
            log.info(
                `[sse] execution_updated received (${framesSeen.length} frames total)`,
            );
            return { pr: opened, framesSeen: framesSeen.length };
        } finally {
            abort.abort();
            try {
                await ctx.provider.closePR(opened);
            } catch {
                /* best effort */
            }
        }
    },
};

/**
 * Minimal SSE client over fetch: resolves true on the first
 * `execution_updated` frame, false on timeout or stream end.
 */
async function listenForExecutionUpdate(params: {
    url: string;
    token: string;
    signal: AbortSignal;
    timeoutMs: number;
    onFrame: (type: string) => void;
}): Promise<boolean> {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    params.signal.addEventListener('abort', onOuterAbort);
    // The timeout RESOLVES the race directly instead of relying on abort
    // propagation through the stream reader — a leaked reader kept the
    // previous version (and its SSE connection) alive for 85+ minutes.
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), params.timeoutMs);
        timeoutHandle.unref?.();
    });

    const read = async (): Promise<boolean> => {
        try {
            const resp = await fetch(params.url, {
                headers: {
                    Authorization: `Bearer ${params.token}`,
                    Accept: 'text/event-stream',
                },
                signal: controller.signal,
            });
            if (!resp.ok || !resp.body) {
                log.warn(`[sse] stream request failed: HTTP ${resp.status}`);
                return false;
            }

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return false;
                buffer += decoder.decode(value, { stream: true });

                // SSE frames are separated by a blank line.
                const frames = buffer.split(/\n\n/);
                buffer = frames.pop() ?? '';
                for (const frame of frames) {
                    const dataLine = frame
                        .split('\n')
                        .find((l) => l.startsWith('data:'));
                    if (!dataLine) continue;
                    try {
                        let payload: unknown = JSON.parse(
                            dataLine.slice(5).trim(),
                        );
                        // Nest's @Sse serialization can double-encode the data
                        // field (a JSON string inside the JSON frame).
                        if (typeof payload === 'string') {
                            try {
                                payload = JSON.parse(payload);
                            } catch {
                                /* keep the string */
                            }
                        }
                        // Nest serializes the MessageEvent object, so the app
                        // payload nests under a `data` key:
                        //   data: {"data":{"type":"ping"}}
                        const obj = payload as Record<string, any>;
                        const type = String(
                            obj?.data?.type ?? obj?.type ?? 'unknown',
                        );
                        params.onFrame(type);
                        if (type === 'execution_updated') return true;
                    } catch {
                        params.onFrame('unparseable');
                    }
                }
            }
        } catch (err) {
            if (!(err instanceof Error && err.name === 'AbortError')) {
                log.warn(`[sse] stream errored: ${String(err)}`);
            }
            return false;
        }
    };

    try {
        return await Promise.race([read(), timedOut]);
    } finally {
        clearTimeout(timeoutHandle);
        // Always tear the connection down, whatever won the race.
        controller.abort();
        params.signal.removeEventListener('abort', onOuterAbort);
    }
}

export default prExecutionSse;
