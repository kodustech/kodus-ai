import type { ModelListing } from '../kernel/types';
import { catalogWithReasoning } from '../kernel/listing-helpers';

/**
 * Vertex can't be listed live: per-project/region availability needs the user's
 * service-account JSON, unavailable to this credential-less GET. So, curated —
 * covering both families (Gemini via createVertex, Claude via
 * createVertexAnthropic). Users on other regions/models can paste an id (the UI
 * allows free-form Vertex model input), so this list is a SUGGESTION, never a
 * gate.
 *
 * A hand-curated list with no way to regenerate it is a list that rots, and this
 * one had: it stopped at Sonnet 4.6 and Gemini 3.5 Flash while Vertex was
 * serving Sonnet 5, Opus 5 and Gemini 3.8 Flash, and `declared-facts` in this
 * same repo already named `gemini-3.7-flash`. Refreshed 2026-09-17 from Vertex
 * itself — the ids below are what it answered, not what a doc said:
 *
 *   TOKEN=$(gcloud auth print-access-token --account=<a vertex SA>)
 *   curl -s -H "Authorization: Bearer $TOKEN" \
 *     https://aiplatform.googleapis.com/v1beta1/publishers/anthropic/models
 *   curl -s -H "Authorization: Bearer $TOKEN" \
 *     https://aiplatform.googleapis.com/v1beta1/publishers/google/models
 *
 * Both are the GLOBAL endpoint on purpose. The regional hosts serve a much older
 * set — us-east5 answered with claude-3-opus and claude-sonnet-4-5 and nothing
 * newer, which is why a bare `claude-sonnet-4-6` 404s there and resolves on
 * `global`.
 */
const CATALOG: Array<{ id: string; name: string }> = [
    { id: 'gemini-3.1-pro-preview', name: 'Vertex Gemini 3.1 Pro' },
    { id: 'gemini-3.8-flash', name: 'Vertex Gemini 3.8 Flash' },
    { id: 'gemini-3.5-flash', name: 'Vertex Gemini 3.5 Flash' },
    { id: 'gemini-2.5-pro', name: 'Vertex Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Vertex Gemini 2.5 Flash' },
    { id: 'claude-opus-5', name: 'Vertex Claude Opus 5' },
    { id: 'claude-sonnet-5', name: 'Vertex Claude Sonnet 5' },
    { id: 'claude-opus-4-8', name: 'Vertex Claude Opus 4.8' },
    { id: 'claude-opus-4-7', name: 'Vertex Claude Opus 4.7' },
    { id: 'claude-sonnet-4-6', name: 'Vertex Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5', name: 'Vertex Claude Haiku 4.5' },
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
