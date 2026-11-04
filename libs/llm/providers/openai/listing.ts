import type { ModelListing } from '../kernel/types';
import {
    bearerHeaders,
    catalogWithReasoning,
    openAiCompatibleModelsUrl,
    parseOpenAiIds,
} from '../kernel/listing-helpers';

/**
 * OpenAI's `/models` lists every model the key can reach, and most of them
 * cannot run a review: embeddings, speech, transcription, image, moderation,
 * realtime/audio, video, computer-use and the legacy completion models. Only
 * the native listing is filtered — a custom endpoint's ids are the customer's.
 */
const NON_CHAT_OPENAI_MODEL =
    /(^|[-.])(embedding|tts|whisper|transcribe|dall-e|image|moderation|realtime|audio|sora|computer-use)([-.]|$)|^(babbage|davinci)(-|$)/i;

export function isOpenAiChatModelId(id: string): boolean {
    return !NON_CHAT_OPENAI_MODEL.test(id);
}

const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

/** Native OpenAI: OpenAI's API, or the credential's own OpenAI-protocol proxy
 *  when it carries a base URL. Bearer, reasoning derived from the cap table. */
const nativeListing: ModelListing = {
    kind: 'http',
    apiKeyEnv: 'API_OPEN_AI_API_KEY',
    defaultBaseURL: OPENAI_API_BASE_URL,
    // Bound the live /models call so a hung request rejects (→ the UI's manual
    // fallback) instead of leaving the connect form stuck on "Loading models…".
    timeoutMs: 15_000,
    // Verbatim, like the runtime (`<baseURL>/responses`): the list has to come
    // from the endpoint the reviews will call.
    url: ({ baseURL }) =>
        `${(baseURL || OPENAI_API_BASE_URL).replace(/\/+$/, '')}/models`,
    headers: ({ apiKey }) => bearerHeaders(apiKey),
    parse: (body) =>
        parseOpenAiIds(body)
            .filter((m) => isOpenAiChatModelId(m.id))
            .map((m) => catalogWithReasoning(m.id)),
};

/** openai_compatible: the org's OWN baseURL (SSRF-gated by the fetcher), plain
 *  id list — an unknown upstream doesn't get reasoning claims. */
const compatibleListing: ModelListing = {
    kind: 'http',
    apiKeyEnv: 'API_OPEN_AI_API_KEY',
    baseURLEnv: 'API_OPENAI_FORCE_BASE_URL',
    defaultBaseURL: 'https://api.openai.com',
    requiresBaseURL: true,
    timeoutMs: 15_000,
    url: ({ baseURL }) => openAiCompatibleModelsUrl(baseURL as string),
    headers: ({ apiKey }) => bearerHeaders(apiKey),
    parse: parseOpenAiIds,
};

export function openAiModelListing(providerId: string): ModelListing | null {
    if (providerId === 'openai_compatible') return compatibleListing;
    if (providerId === 'openai') return nativeListing;
    return null;
}
