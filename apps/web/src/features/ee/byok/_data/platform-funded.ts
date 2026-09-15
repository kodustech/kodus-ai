/**
 * The `kodus` BYOK provider — "Kodus as the provider". The org picks a model
 * and Kodus routes it over its OWN upstream accounts, billing the org's Kodus
 * credits. Web mirror of `isPlatformFundedProvider` in
 * libs/llm/platform-funded-provider.ts (the web bundle cannot import a value
 * from libs/llm), so the one exception to "a credential carries a key" is
 * stated in one place on this side too.
 */
export const KODUS_PROVIDER_ID = "kodus";

export const isPlatformFundedProvider = (provider?: string | null): boolean =>
    provider === KODUS_PROVIDER_ID;
