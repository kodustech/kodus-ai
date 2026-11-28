import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { loadPreviewEdgeConfig, loadRuntimeConfig } from './config';

// Preview settings (docs/runtime/preview-urls.md §4.4, decision 1).

const dir = mkdtempSync(join(tmpdir(), 'kr-preview-config-'));
const pem = join(dir, 'x.pem');
writeFileSync(pem, 'not read by the loader beyond its presence');
const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const edgeEnv = (over: Record<string, string | undefined> = {}) => ({
    RUNTIME_PREVIEW_DOMAIN: 'kodus-preview.example',
    RUNTIME_PREVIEW_APP_URL: 'https://app.kodus.io',
    RUNTIME_PREVIEW_GRANT_PUBLIC_KEY: Buffer.from(publicKey).toString('base64'),
    RUNTIME_PREVIEW_TLS_CERT: pem,
    RUNTIME_PREVIEW_TLS_KEY: pem,
    RUNTIME_PREVIEW_TUNNEL_TLS_CERT: pem,
    RUNTIME_PREVIEW_TUNNEL_TLS_KEY: pem,
    RUNTIME_TLS_CA: pem,
    ...over,
});

describe('preview configuration', () => {
    it('previews are off until a preview domain is set', () => {
        expect(loadRuntimeConfig({}).previewDomain).toBeUndefined();
        expect(loadRuntimeConfig({ RUNTIME_PREVIEW_DOMAIN: 'Kodus-Preview.example' }).previewDomain).toBe('kodus-preview.example');
        expect(() => loadRuntimeConfig({ RUNTIME_PREVIEW_DOMAIN: '*.kodus-preview.example' })).toThrow(/bare DNS name/);
        expect(() => loadRuntimeConfig({ RUNTIME_PREVIEW_TUNNEL_URL: 'ws://edge/v1/cells/tunnel' })).toThrow(/wss/);
    });

    it('the edge refuses to start without its own domain', () => {
        expect(() => loadPreviewEdgeConfig(edgeEnv({ RUNTIME_PREVIEW_DOMAIN: undefined }))).toThrow(/RUNTIME_PREVIEW_DOMAIN is required/);
    });

    it('the edge refuses a preview domain of the same site as the web app, unless allowed', () => {
        expect(() => loadPreviewEdgeConfig(edgeEnv({ RUNTIME_PREVIEW_DOMAIN: 'preview.kodus.io' }))).toThrow(/same site/);
        expect(loadPreviewEdgeConfig(edgeEnv({ RUNTIME_PREVIEW_DOMAIN: 'preview.kodus.io', RUNTIME_PREVIEW_ALLOW_SAME_SITE: 'true' })).domain).toBe('preview.kodus.io');
    });

    it('the edge takes the grant public key as a PEM or its base64, and needs the cell CA for the tunnel', () => {
        expect(loadPreviewEdgeConfig(edgeEnv()).grantPublicKey).toContain('BEGIN PUBLIC KEY');
        const der = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
        expect(loadPreviewEdgeConfig(edgeEnv({ RUNTIME_PREVIEW_GRANT_PUBLIC_KEY: der })).grantPublicKey).toContain('BEGIN PUBLIC KEY');
        expect(() => loadPreviewEdgeConfig(edgeEnv({ RUNTIME_TLS_CA: undefined }))).toThrow(/mTLS/);
    });

    it('the edge sends a session back for a fresh grant every 15 minutes by default, configurable up to the 12 h session (#9)', () => {
        expect(loadPreviewEdgeConfig(edgeEnv()).sessionRevalidateMinutes).toBe(15);
        expect(loadPreviewEdgeConfig(edgeEnv({ RUNTIME_PREVIEW_SESSION_REVALIDATE_MINUTES: '5' })).sessionRevalidateMinutes).toBe(5);
        expect(() => loadPreviewEdgeConfig(edgeEnv({ RUNTIME_PREVIEW_SESSION_REVALIDATE_MINUTES: '0' }))).toThrow(/RUNTIME_PREVIEW_SESSION_REVALIDATE_MINUTES/);
        expect(() => loadPreviewEdgeConfig(edgeEnv({ RUNTIME_PREVIEW_SESSION_REVALIDATE_MINUTES: '721' }))).toThrow(/<= 720/);
    });

    it('an edge replica names where the others forward to only as an http(s) origin', () => {
        expect(loadPreviewEdgeConfig(edgeEnv()).internalUrl).toBeUndefined();
        expect(loadPreviewEdgeConfig(edgeEnv({ RUNTIME_PREVIEW_EDGE_INTERNAL_URL: 'http://10.0.1.5:3430' })).internalUrl).toBe('http://10.0.1.5:3430');
        expect(() => loadPreviewEdgeConfig(edgeEnv({ RUNTIME_PREVIEW_EDGE_INTERNAL_URL: 'http://10.0.1.5:3430/x' }))).toThrow(/origin/);
        expect(() => loadPreviewEdgeConfig(edgeEnv({ RUNTIME_PREVIEW_EDGE_INTERNAL_URL: 'ftp://edge' }))).toThrow(/origin/);
    });
});
