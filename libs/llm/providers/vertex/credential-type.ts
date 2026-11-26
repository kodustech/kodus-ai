import { parseSaCredentials } from '@libs/llm/model-builders';

/**
 * A Vertex BYOK key is handed to google-auth-library, which acts on the
 * credential's `type`: for `external_account` it GETs the key's
 * `credential_source.url` and POSTs what it read to its `token_url`, both
 * chosen by whoever wrote the key, through its own transport. An org's key is
 * accepted only as a service account key (untyped JSON is one to the library
 * too); a value that is no JSON is left to the builder (it degrades to an AI
 * Studio key).
 */
export class VertexCredentialTypeError extends Error {
    readonly code = 'EBYOK_CONFIG_INVALID';
    constructor(readonly credentialType: string) {
        super(
            'The Vertex key is not a service account key (type "service_account"), so the call was not sent.',
        );
        this.name = 'VertexCredentialTypeError';
    }
}

export function assertVertexServiceAccountKey(
    saJsonOrBase64: string | undefined,
): void {
    const parsed = parseSaCredentials(saJsonOrBase64 ?? '') as {
        type?: unknown;
    } | null;
    if (!parsed || typeof parsed !== 'object') return;
    // No type reads as a service account to google-auth-library too.
    if (parsed.type !== undefined && parsed.type !== 'service_account') {
        throw new VertexCredentialTypeError(String(parsed.type));
    }
}
