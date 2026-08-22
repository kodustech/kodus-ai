import type { ModelListing } from '../kernel/types';
import { catalogWithReasoning } from '../kernel/listing-helpers';

/**
 * Vertex can't be listed live: per-project/region availability needs the user's
 * service-account JSON, unavailable to this credential-less GET. So, curated —
 * covering both families (Gemini via createVertex, Claude via
 * createVertexAnthropic). Users on other regions/models can paste an id (the UI
 * allows free-form Vertex model input).
 */
const CATALOG: Array<{ id: string; name: string }> = [
    { id: 'gemini-3.1-pro-preview', name: 'Vertex Gemini 3.1 Pro' },
    { id: 'gemini-3.5-flash', name: 'Vertex Gemini 3.5 Flash' },
    { id: 'gemini-2.5-pro', name: 'Vertex Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Vertex Gemini 2.5 Flash' },
    { id: 'claude-opus-4-8', name: 'Vertex Claude Opus 4.8' },
    { id: 'claude-opus-4-7', name: 'Vertex Claude Opus 4.7' },
    { id: 'claude-sonnet-4-6', name: 'Vertex Claude Sonnet 4.6' },
];

// Capability lookup keys on a bare model name; strip the Vertex `@<version>`
// suffix so versioned Claude entries resolve their reasoning config.
const reasoningKeyOf = (id: string): string => id.split('@')[0];

const staticListing: ModelListing = {
    kind: 'static',
    models: CATALOG.map(({ id, name }) =>
        catalogWithReasoning(id, name, reasoningKeyOf(id)),
    ),
};

export function vertexModelListing(providerId: string): ModelListing | null {
    return providerId === 'google_vertex' ? staticListing : null;
}
