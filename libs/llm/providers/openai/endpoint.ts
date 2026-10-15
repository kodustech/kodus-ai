/**
 * Where an OpenAI reasoning model is served from.
 *
 * OpenAI's own API serves it on /v1/responses, where an agent loop's function
 * tools and `reasoning_effort` go together. On /v1/chat/completions the
 * gpt-5.6 / gpt-6 line refuses that pair:
 *
 *   Function tools with reasoning_effort are not supported for gpt-6-sol in
 *   /v1/chat/completions. To use function tools, use /v1/responses or set
 *   reasoning_effort to 'none'.
 *
 * and every agent loop sends both (the reasoning default is 'medium' for a model
 * that thinks by default). The OpenAI-compatible transport speaks chat
 * completions only, so a reasoning model of OpenAI's own families pointed at
 * OpenAI itself is OpenAI, whichever provider id reached it: a self-hosted env
 * model (`API_LLM_PROVIDER_MODEL`) and a BYOK `openai_compatible` credential on
 * api.openai.com.
 *
 * Any other host (a gateway, LiteLLM, a self-hosted proxy) may not serve
 * /v1/responses, so it is not assumed to: it stays on chat completions, where a
 * refusal of the pair is asked again without the effort
 * (rejected-reasoning-field.ts).
 */
import { isOpenAiReasonerId } from '../kernel/model-family';

/** A base URL on OpenAI's own API host. */
export function isOpenAiHost(baseURL: string | undefined): boolean {
    if (!baseURL) return false;
    try {
        return new URL(baseURL).hostname.toLowerCase() === 'api.openai.com';
    } catch {
        return false;
    }
}

/** An OpenAI reasoning model on OpenAI's own host: it belongs on the native
 *  SDK (/v1/responses), not on the OpenAI-compatible one. */
export function servedByOpenAi(
    model: string,
    baseURL: string | undefined,
): boolean {
    return isOpenAiReasonerId(model) && isOpenAiHost(baseURL);
}
