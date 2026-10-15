/**
 * OpenAI keeps every /v1/responses call unless told not to: `store` defaults to
 * true there, while chat completions stores nothing by default. A review sends
 * the PR's diff and code, and neither a BYOK org nor a self-hosted install chose
 * to have OpenAI retain them, so every call on OpenAI's own API goes out with
 * `store: false` (#2135 review).
 *
 * Without the stored item, a multi-step tool loop has nothing to point its
 * reasoning at (the SDK resends it as an `item_reference`), so every call also
 * asks for `reasoning.encrypted_content` and carries it between steps, as the
 * Codex route does (codex-subscription-model.ts). Always, not only for ids
 * recognized as reasoners: a fine-tune or an aliased deployment reasons too,
 * and OpenAI accepts the include on a model that does not (gpt-4o and
 * gpt-4.1-mini answer 200, 2026-10-15). An option the caller set explicitly (a
 * pasted override) still wins.
 */
import type { LanguageModel } from 'ai';

export function notStoredByOpenAi(model: LanguageModel): LanguageModel {
    if (typeof model !== 'object' || model === null) return model;
    const notStored = {
        store: false,
        include: ['reasoning.encrypted_content'],
    };
    const withOptions = (options: any) => ({
        ...options,
        providerOptions: {
            ...(options?.providerOptions ?? {}),
            openai: {
                ...notStored,
                ...(options?.providerOptions?.openai ?? {}),
            },
        },
    });
    return new Proxy(model, {
        get(target: any, prop, receiver) {
            if (prop === 'doGenerate' || prop === 'doStream') {
                return (options: any) => target[prop](withOptions(options));
            }
            return Reflect.get(target, prop, receiver);
        },
    }) as LanguageModel;
}
