/**
 * LLM call timeouts + a hard-timeout-wrapped `generateText` — domain-agnostic.
 *
 * Some BYOK providers (Synthetic, Z.AI and other OpenAI-compatible proxies)
 * ignore AbortSignal and hang forever; `hardTimeout` is the safety net that
 * guarantees every model call has a maximum wall-clock time. `tracedGenerateText`
 * is the AI SDK `generateText` with that net applied — Langfuse tracing is
 * consumed via `telemetry` on each call by the caller.
 */
import { generateText as _aiSdkGenerateText } from 'ai';

export const AGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes max per agent
// 10 minutes per individual LLM call — matches the undici headersTimeout
// set in the worker bootstrap so neither layer aborts the other. Large
// Gemini calls (>500K prompt + high reasoning) can legitimately take
// 4-7 minutes of wall-clock before the first byte arrives.
export const LLM_CALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Create an AbortSignal that fires after the given ms. */
export function timeoutSignal(ms: number): AbortSignal {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    // The timeout is only a guard: a settled call clears its own path, so the
    // pending timer must NOT keep the event loop (a worker, or Jest) alive on
    // its own. unref lets the process exit once the real work is done while the
    // guard still fires if the process is otherwise busy waiting on the call.
    if (typeof timer.unref === 'function') {
        timer.unref();
    }
    return controller.signal;
}

/**
 * Hard timeout wrapper — kills the promise even if the provider ignores AbortSignal.
 * Uses Promise.race so that a stuck HTTP connection can never block the pipeline forever.
 *
 * Every generateText call already passes timeoutSignal(ms) as AbortSignal,
 * but some providers (OpenAI-compatible proxies like Synthetic, Z.AI) ignore it.
 * This is the safety net.
 */
export function hardTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(
                () =>
                    reject(
                        new Error(
                            `[HARD-TIMEOUT] ${label} exceeded ${ms / 1000}s`,
                        ),
                    ),
                ms + 5_000, // +5s grace so AbortSignal fires first when it works
            );
        }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * `generateText` with a hard timeout safety net. Re-exported as
 * `tracedGenerateText` for use anywhere outside an agent loop.
 */
const generateText: typeof _aiSdkGenerateText = (async (
    ...args: Parameters<typeof _aiSdkGenerateText>
) => {
    const opts = args[0] as any;
    const ms =
        opts?.__kodusHardTimeoutMs ??
        (opts?.abortSignal
            ? LLM_CALL_TIMEOUT_MS // secondary calls already set timeoutSignal
            : AGENT_TIMEOUT_MS); // main call uses agent-level timeout
    const label =
        opts?.telemetry?.functionId ||
        opts?.experimental_telemetry?.functionId ||
        'generateText';
    return hardTimeout(_aiSdkGenerateText(...args), ms, label);
}) as typeof _aiSdkGenerateText;

export { generateText as tracedGenerateText };
