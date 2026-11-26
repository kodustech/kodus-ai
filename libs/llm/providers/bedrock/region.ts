import { quoteConfigValue } from '../quote-config-value';

/**
 * The Bedrock hosts are built from the region the org types
 * (`bedrock-runtime.<region>.amazonaws.com`, `bedrock.<region>…`), so a value
 * that is not a region name could turn the host into one the org chose
 * (`localhost:8080/#` → `bedrock-runtime.localhost:8080`). Only the AWS region
 * shape is accepted: `us-east-1`, `eu-central-2`, `us-gov-west-1`.
 */
export const AWS_REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

export class BedrockRegionInvalidError extends Error {
    readonly code = 'EBYOK_CONFIG_INVALID';
    constructor(readonly region: string) {
        super(
            `The AWS region "${quoteConfigValue(region, 64)}" of this Bedrock key is not an AWS region name (like us-east-1), so the call was not sent.`,
        );
        this.name = 'BedrockRegionInvalidError';
    }
}

/** The region to build a host from: trimmed, `us-east-1` when unset; throws
 *  `BedrockRegionInvalidError` for anything that is not a region name. */
export function bedrockRegion(raw: string | undefined | null): string {
    const region = (raw ?? '').trim() || 'us-east-1';
    if (!AWS_REGION_RE.test(region))
        throw new BedrockRegionInvalidError(region);
    return region;
}
