/**
 * Title and body of the "BYOK model is failing" banner.
 *
 * Worded from the category of the error that tripped the threshold
 * (`LlmErrorCategory`, carried on the notification). It used to say "often an
 * insufficient balance or a suspended/expired account" for every failure, and a
 * customer with credit and an active key, rate limited on a free model, went
 * looking at billing (#1871). When the category is unknown the banner names no
 * cause at all: the provider's own answer is under "Show details".
 */
export function byokFailureCopy(
    provider: string,
    category?: string,
): { title: string; body: string } {
    const tail = "Reviews using this model may fail until it's resolved.";

    switch (category) {
        case "AUTH_INVALID":
            return {
                title: `Your ${provider} key is being rejected`,
                body: `${provider} refused the API key — check that it hasn't been revoked or expired. ${tail}`,
            };
        case "QUOTA_EXCEEDED":
            return {
                title: `Your ${provider} account is out of quota`,
                body: `${provider} reports the account's credit or quota is used up — often an insufficient balance or a spending cap. ${tail}`,
            };
        case "RATE_LIMIT":
            return {
                title: `${provider} is rate limiting your key`,
                body: `${provider} is refusing requests over its rate limit. Free model variants have low limits. ${tail}`,
            };
        case "MODEL_NOT_FOUND":
        case "MODEL_ACCESS_DENIED":
            return {
                title: `${provider} can't serve the configured model`,
                body: `${provider} rejected the configured model — check the model id and whether the account has access to it. ${tail}`,
            };
        default:
            return {
                title: `Reviews on your ${provider} model are failing`,
                body: `${provider} returned errors on recent requests. Its latest answer is in the details below. ${tail}`,
            };
    }
}
