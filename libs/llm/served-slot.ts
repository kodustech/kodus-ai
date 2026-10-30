/**
 * The slot as the call is made.
 *
 * An `openai_compatible` credential on api.openai.com running one of OpenAI's
 * reasoning models is served as `openai`: built on the native SDK
 * (/v1/responses), and reasoned and typed as OpenAI, because on chat
 * completions the gpt-5.6 / gpt-6 line refuses an agent loop's tools together
 * with its effort (providers/openai/endpoint.ts). The stored config keeps the
 * provider the user chose; only the call changes.
 *
 * Applied where a slot becomes a call — routing (resolveTaskSlot), an explicit
 * slot handed to LLM.run, and the connection probe — so a connection test and a
 * review use the same transport. The model, its reasoning options and its
 * structured-output plan all read the served provider, which is why the swap is
 * not made inside the model build alone.
 */
import type { NormalizedModel } from './byok-config';
import { BYOKProvider } from './model-providers';
import { servedByOpenAi } from './providers/openai/endpoint';

export function asServedSlot<T extends NormalizedModel>(slot: T): T {
    const fallback = slot.fallback
        ? asServedSlot(slot.fallback)
        : slot.fallback;
    const withFallback =
        fallback === slot.fallback ? slot : { ...slot, fallback };
    if (
        withFallback.provider !== BYOKProvider.OPENAI_COMPATIBLE ||
        !servedByOpenAi(withFallback.model, withFallback.baseURL)
    ) {
        return withFallback;
    }
    return {
        ...withFallback,
        provider: BYOKProvider.OPENAI,
        // The native SDK already targets that host, and a pasted URL without
        // `/v1` would miss it.
        baseURL: undefined,
        reasoningConfigOverride: overrideForOpenAi(
            withFallback.reasoningConfigOverride,
        ),
    };
}

/**
 * A pasted reasoning override namespaced for the compatible adapter would reach
 * the native one unread; it moves under `openai`, which reads the same option
 * names (`reasoningEffort`). Anything else is left as pasted.
 */
function overrideForOpenAi(raw: string | undefined): string | undefined {
    if (!raw) return raw;
    try {
        const parsed = JSON.parse(raw);
        if (
            !parsed ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed) ||
            !parsed.openaiCompatible
        ) {
            return raw;
        }
        const { openaiCompatible, ...rest } = parsed;
        return JSON.stringify({
            ...rest,
            openai: { ...(rest.openai ?? {}), ...openaiCompatible },
        });
    } catch {
        return raw;
    }
}
