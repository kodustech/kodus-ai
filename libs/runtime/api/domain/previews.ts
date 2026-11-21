import { createPrivateKey, type KeyObject } from 'crypto';

import type { PreviewAuditAction, PreviewOpen, PreviewRef, PreviewSettings, PreviewSide, PreviewView } from '@libs/runtime/contracts/preview';

// The runtime-worker's preview routes (PREVIEW_ROUTES on its env-session
// listener, docs/runtime/preview-urls.md §9.2). The worker owns the preview
// records; the API only checks access and mints grants. A refusal comes back
// as EnvSessionPortError (status, code, message), like the env-session routes.

export const RUNTIME_PREVIEW_PORT = Symbol('RUNTIME_PREVIEW_PORT');

export interface RuntimePreviewPort {
    openPreview(req: PreviewOpen): Promise<PreviewView>;
    previewStatus(ref: PreviewRef): Promise<PreviewView>;
    stopPreview(ref: PreviewRef): Promise<PreviewView>;
}

/**
 * The grant signing key from RUNTIME_PREVIEW_GRANT_PRIVATE_KEY: a PKCS8 PEM
 * (literal "\n" escapes allowed, as env files carry it) or the base64 of a
 * PKCS8 DER. Anything that is not an Ed25519 private key throws: the grant
 * is EdDSA only (RFC 8037), never another algorithm.
 */
export function previewGrantKeyFrom(raw: string): KeyObject {
    const text = raw.trim();
    const key = text.startsWith('-----BEGIN')
        ? createPrivateKey({ key: text.replace(/\\n/g, '\n'), format: 'pem' })
        : createPrivateKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('RUNTIME_PREVIEW_GRANT_PRIVATE_KEY must be an Ed25519 private key');
    return key;
}

/** The org's preview settings (product Postgres, runtime_settings.preview), written only by the API. */
export const RUNTIME_PREVIEW_SETTINGS_STORE = Symbol.for('RuntimeApi.PreviewSettingsStore');
export interface RuntimePreviewSettingsStore {
    /** The stored settings with the defaults filled in (previewSettingsOf): never null. */
    getPreviewSettings(organizationId: string): Promise<PreviewSettings>;
    setPreviewSettings(organizationId: string, settings: PreviewSettings): Promise<void>;
}

/** One row of runtime_preview_audit as the owner reads it: ids, an action and its reason, counts. Never an IP, a path or a token. */
export interface PreviewAuditRecord {
    at: string;
    organizationId: string;
    previewId: string;
    runId?: string;
    side?: PreviewSide;
    /** A user id. */
    actor?: string;
    action: PreviewAuditAction | 'session_closed';
    reason?: string;
    requests?: number;
    bytesIn?: number;
    bytesOut?: number;
}

/** The Runtime Postgres's preview audit, read-only (RUNTIME_DATABASE_READ_URL; the reader's grant on runtime_preview_audit). */
export const RUNTIME_PREVIEW_AUDIT_READER = Symbol.for('RuntimeApi.PreviewAuditReader');
export interface RuntimePreviewAuditReader {
    /** The org's rows, newest first, before `before` when set, of one preview when asked; at most `limit`. */
    list(input: { organizationId: string; limit: number; before?: string; previewId?: string }): Promise<PreviewAuditRecord[]>;
    /** Sessions opened in [start, end): the usage report's preview row. */
    sessionsOfMonth(organizationId: string, window: { start: Date; end: Date }): Promise<number>;
}
