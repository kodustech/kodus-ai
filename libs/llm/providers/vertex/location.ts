/**
 * @ai-sdk/google-vertex builds the host from the location the org types
 * (`https://<location>-aiplatform.googleapis.com/...`, or the bare
 * `aiplatform.googleapis.com` for `global`), and a Vertex slot has no base URL
 * for the gateway address check to judge, so a value that is not a location
 * name could turn the host into one the org chose (`x.attacker.test/#`). Only
 * the location shape is accepted: `global`, `us`, `eu`, `us-central1`,
 * `europe-west4`, `northamerica-northeast1`.
 */
export const VERTEX_LOCATION_RE = /^[a-z]+(?:-[a-z]+)*\d*$/;

export class VertexLocationInvalidError extends Error {
    readonly code = 'EBYOK_CONFIG_INVALID';
    constructor(readonly location: string) {
        super(
            `The location "${location.slice(0, 64)}" of this Vertex key is not a Vertex location (like global or us-central1), so the call was not sent.`,
        );
        this.name = 'VertexLocationInvalidError';
    }
}

/** The location to build a host from: trimmed, `global` when unset; throws
 *  `VertexLocationInvalidError` for anything that is not a location name. */
export function vertexLocation(raw: string | undefined | null): string {
    const location = (raw ?? '').trim() || 'global';
    if (!VERTEX_LOCATION_RE.test(location))
        throw new VertexLocationInvalidError(location);
    return location;
}
