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

// 20 minutes max per agent. This is the wall-clock ceiling for a whole
// agent run (the sum of its sequential model calls), NOT a single call —
// that's LLM_CALL_TIMEOUT_MS below. It MUST stay below the slowest
// consumer's patience so a long review aborts and still reaches the
// posting stages (finish-comments) instead of being cut off mid-run with
// nothing posted. Concretely it must be < the E2E command-review poll
// window (1500s / 25 min in command-review-focus.ts) — otherwise a slow
// review reads as "no review posted" and the whole matrix job times out.
// Lowered from 30 min for exactly that reason (fix/review-timeout-robustness).
export const AGENT_TIMEOUT_MS = 20 * 60 * 1000;
// 10 minutes per individual LLM call — matches the undici headersTimeout
// set in the worker bootstrap so neither layer aborts the other. Large
// Gemini calls (>500K prompt + high reasoning) can legitimately take
// 4-7 minutes of wall-clock before the first byte arrives.
export const LLM_CALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Create an AbortSignal that fires after the given ms. */
export function timeoutSignal(ms: number): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
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
