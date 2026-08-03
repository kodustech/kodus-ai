import type { ModelListing } from '../kernel/types';
import { catalogWithReasoning } from '../kernel/listing-helpers';

/**
 * Bedrock model ids are region-scoped and inference profiles vary per AWS
 * account, so we can't list generically without the user's AWS creds. Curated
 * set of `us.*` cross-region inference profiles covering common code-review use;
 * eu/apac users can paste an id (the UI allows free-form Bedrock model input).
 */
const CATALOG: Array<{ id: string; name: string }> = [
    { id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', name: 'Claude Sonnet 4.5 (us, cross-region)' },
    { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0', name: 'Claude Sonnet 4 (us, cross-region)' },
    { id: 'us.anthropic.claude-opus-4-1-20250805-v1:0', name: 'Claude Opus 4.1 (us, cross-region)' },
    { id: 'us.anthropic.claude-opus-4-20250514-v1:0', name: 'Claude Opus 4 (us, cross-region)' },
    { id: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0', name: 'Claude 3.7 Sonnet (us, cross-region)' },
    { id: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet v2 (us, cross-region)' },
    { id: 'us.anthropic.claude-3-5-haiku-20241022-v1:0', name: 'Claude 3.5 Haiku (us, cross-region)' },
];

// Look up caps by the Anthropic-style suffix (after "us.anthropic.").
const reasoningKeyOf = (id: string): string => {
    const match = id.match(/^[a-z]{2,5}\.anthropic\.(.+?)-v\d+:\d+$/);
    return match ? match[1] : id;
};

const staticListing: ModelListing = {
    kind: 'static',
    models: CATALOG.map(({ id, name }) =>
        catalogWithReasoning(id, name, reasoningKeyOf(id)),
    ),
};

export function bedrockModelListing(providerId: string): ModelListing | null {
    return providerId === 'amazon_bedrock' ? staticListing : null;
}
