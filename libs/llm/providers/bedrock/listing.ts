import type { ModelListing, CatalogModel } from '../kernel/types';
import { catalogWithReasoning } from '../kernel/listing-helpers';

/**
 * Curated fallback — the well-known `us.*` cross-region inference profiles for
 * common code-review use. Used when the LIVE listing can't run (no bearer token,
 * IAM-only creds, or the AWS call failed). The EOL Claude 3.5 Haiku profile is
 * deliberately NOT here — AWS retired it, so it must never be offered as a pick.
 */
const CURATED: Array<{ id: string; name: string }> = [
    { id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', name: 'Claude Sonnet 4.5 (us, cross-region)' },
    { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0', name: 'Claude Sonnet 4 (us, cross-region)' },
    { id: 'us.anthropic.claude-opus-4-1-20250805-v1:0', name: 'Claude Opus 4.1 (us, cross-region)' },
    { id: 'us.anthropic.claude-opus-4-20250514-v1:0', name: 'Claude Opus 4 (us, cross-region)' },
    { id: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0', name: 'Claude 3.7 Sonnet (us, cross-region)' },
    { id: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet v2 (us, cross-region)' },
];

// Look up caps by the Anthropic-style suffix (after "us.anthropic.").
const reasoningKeyOf = (id: string): string => {
    const match = id.match(/^[a-z]{2,5}\.anthropic\.(.+?)-v\d+:\d+$/);
    return match ? match[1] : id;
};

/** The curated catalog as CatalogModels (reasoning caps joined) — the module's
 *  editorial fallback, surfaced by the fetcher when the live call can't run. */
export const BEDROCK_CURATED_CATALOG: CatalogModel[] = CURATED.map(
    ({ id, name }) => catalogWithReasoning(id, name, reasoningKeyOf(id)),
);

/** AWS regions are `<area>-<name>-<number>` (e.g. us-east-1, eu-central-1). The
 *  region flows from user config INTO the request host, so validate it strictly
 *  before it can shape the URL — an unvalidated region is an SSRF vector. */
const AWS_REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;

/**
 * Amazon Bedrock model listing.
 *
 * LIVE when a Bedrock API key (bearer token) + a valid region are available: hits
 * the control-plane `ListInferenceProfiles` for the user's OWN account/region, so
 * the picker shows exactly the SYSTEM_DEFINED profiles that account can invoke —
 * and never a retired one. The bearer token authenticates directly
 * (`Authorization: Bearer …`), so no SigV4 signing is needed. IAM-only creds (no
 * bearer) and the no-cred setup path fall back to {@link BEDROCK_CURATED_CATALOG}
 * via the fetcher (SigV4 can't be expressed as pure headers).
 */
const httpListing: ModelListing = {
    kind: 'http',
    timeoutMs: 10_000,
    // No bearer / IAM-only / pre-save → the picker still lists the curated set.
    fallbackModels: BEDROCK_CURATED_CATALOG,
    url: (creds) => {
        const region = (creds.awsRegion ?? '').trim();
        if (!AWS_REGION_RE.test(region)) {
            // No/invalid region → refuse to build a host from it (SSRF guard). The
            // fetcher catches and degrades to the curated catalog.
            throw new Error(
                'A valid AWS region is required to list Bedrock models.',
            );
        }
        // ListInferenceProfiles filters on `typeEquals` (enum SYSTEM_DEFINED |
        // APPLICATION), NOT `type` — a wrong key is silently ignored and the call
        // returns every profile instead of just the cross-region system ones.
        return `https://bedrock.${region}.amazonaws.com/inference-profiles?maxResults=1000&typeEquals=SYSTEM_DEFINED`;
    },
    headers: (creds) => ({
        Authorization: `Bearer ${creds.awsBearerToken ?? ''}`,
        Accept: 'application/json',
    }),
    parse: (body: unknown): CatalogModel[] => {
        const summaries =
            (body as { inferenceProfileSummaries?: unknown })
                ?.inferenceProfileSummaries;
        if (!Array.isArray(summaries)) return [];
        return summaries
            .map((s) => s as Record<string, unknown>)
            // Only invocable profiles — a non-ACTIVE one can't be used for review.
            .filter((s) => (s.status ?? 'ACTIVE') === 'ACTIVE')
            .map((s) => {
                const id = typeof s.inferenceProfileId === 'string'
                    ? s.inferenceProfileId
                    : '';
                const name = typeof s.inferenceProfileName === 'string'
                    ? s.inferenceProfileName
                    : id;
                return id
                    ? catalogWithReasoning(id, name, reasoningKeyOf(id))
                    : null;
            })
            .filter((m): m is CatalogModel => m !== null);
    },
};

export function bedrockModelListing(providerId: string): ModelListing | null {
    return providerId === 'amazon_bedrock' ? httpListing : null;
}
