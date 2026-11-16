import { generateKeyPairSync } from 'crypto';

import {
    isSameSite,
    newPreviewHostLabel,
    PREVIEW_COOKIE,
    previewIdFor,
    previewLabelOf,
    previewRequestHeaders,
    previewResponseHeaders,
    previewSessionCookie,
    previewSessionOf,
    signPreviewGrant,
    verifyPreviewGrant,
    withoutPreviewCookie,
} from './preview';

const keys = () => generateKeyPairSync('ed25519');
const HOST = 'p-abcdefghijklmnopqrstuvwxyz-pr.preview.example';
const NOW = Date.parse('2026-11-12T12:00:00Z');
const grant = (privateKey = keys().privateKey, host = HOST) =>
    signPreviewGrant(privateKey, { host, userId: 'user-1', organizationId: 'org-a', previewId: previewIdFor('org-a', 'run-1', 'pr'), side: 'pr', now: NOW });

describe('preview grant', () => {
    it('is accepted for its own host inside its 60 seconds', () => {
        const k = keys();
        const { token, claims } = grant(k.privateKey);
        expect(verifyPreviewGrant(k.publicKey, token, { host: HOST, now: NOW + 59_000 })).toEqual({ ok: true, claims });
    });

    it('is refused past its expiry, for another host, or signed by another key', () => {
        const k = keys();
        const { token } = grant(k.privateKey);
        expect(verifyPreviewGrant(k.publicKey, token, { host: HOST, now: NOW + 60_000 })).toEqual({ ok: false, reason: 'expired' });
        expect(verifyPreviewGrant(k.publicKey, token, { host: 'p-zzzzzzzzzzzzzzzzzzzzzzzzzz-pr.preview.example', now: NOW })).toEqual({ ok: false, reason: 'wrong_audience' });
        expect(verifyPreviewGrant(keys().publicKey, token, { host: HOST, now: NOW })).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('is refused when the header names another algorithm or type, or the payload was changed', () => {
        const k = keys();
        const [h, p, s] = grant(k.privateKey).token.split('.');
        const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'kodus-preview-grant+jwt' })).toString('base64url');
        expect(verifyPreviewGrant(k.publicKey, `${none}.${p}.${s}`, { host: HOST, now: NOW }).ok).toBe(false);
        const longer = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), exp: NOW / 1000 + 3600 })).toString('base64url');
        expect(verifyPreviewGrant(k.publicKey, `${h}.${longer}.${s}`, { host: HOST, now: NOW })).toEqual({ ok: false, reason: 'bad_signature' });
        expect(verifyPreviewGrant(k.publicKey, 'not-a-jws', { host: HOST, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
    });
});

describe('preview ids and hosts', () => {
    it('one side of one Run is one preview id, and the id names neither org nor Run', () => {
        const a = previewIdFor('org-a', 'run-1', 'pr');
        expect(a).toBe(previewIdFor('org-a', 'run-1', 'pr'));
        expect(a).not.toBe(previewIdFor('org-b', 'run-1', 'pr'));
        expect(a).not.toBe(previewIdFor('org-a', 'run-1', 'base'));
        expect(a).toMatch(/^prv_[a-z2-7]{26}$/);
    });

    it('a host that does not match the scheme gets no label', () => {
        const label = newPreviewHostLabel('base');
        expect(previewLabelOf(`${label}.preview.example:443`, 'preview.example')).toBe(label);
        expect(previewLabelOf(`x.${label}.preview.example`, 'preview.example')).toBeNull();
        expect(previewLabelOf('app.kodus.io', 'preview.example')).toBeNull();
        expect(previewLabelOf('preview.example', 'preview.example')).toBeNull();
        expect(previewLabelOf(`${label}.preview.example.evil.test`, 'preview.example')).toBeNull();
    });

    it('a preview domain under the app domain is the same site', () => {
        expect(isSameSite('preview.kodus.io', 'app.kodus.io')).toBe(true);
        expect(isSameSite('kodus-preview.app', 'app.kodus.io')).toBe(false);
        expect(isSameSite('preview.acme.co.uk', 'kodus.acme.co.uk')).toBe(true);
    });
});

describe('preview cookie', () => {
    it('is __Host-, Secure, HttpOnly, SameSite=Lax, Path=/ and has no Domain', () => {
        const c = previewSessionCookie('a'.repeat(43), 3600);
        expect(c.startsWith(`${PREVIEW_COOKIE}=`)).toBe(true);
        expect(c).toContain('; Secure');
        expect(c).toContain('; HttpOnly');
        expect(c).toContain('; SameSite=Lax');
        expect(c).toContain('; Path=/');
        expect(c.toLowerCase()).not.toContain('domain=');
    });

    it('is read from the Cookie header and never forwarded with the others', () => {
        const header = `theme=dark; ${PREVIEW_COOKIE}=${'b'.repeat(43)}; app_session=xyz`;
        expect(previewSessionOf(header)).toBe('b'.repeat(43));
        expect(withoutPreviewCookie(header)).toBe('theme=dark; app_session=xyz');
        expect(withoutPreviewCookie(`${PREVIEW_COOKIE}=${'b'.repeat(43)}`)).toBeUndefined();
    });
});

describe('preview headers', () => {
    it('the app never gets the edge cookie, the client X-Forwarded-For or a hop-by-hop header', () => {
        const out = previewRequestHeaders(
            {
                cookie: `${PREVIEW_COOKIE}=${'c'.repeat(43)}; a=1`,
                'x-forwarded-for': '203.0.113.9',
                forwarded: 'for=203.0.113.9',
                'x-real-ip': '203.0.113.9',
                connection: 'keep-alive, x-secret-hop',
                'x-secret-hop': '1',
                'keep-alive': 'timeout=5',
                'transfer-encoding': 'chunked',
                'kodus-preview-id': 'prv_spoofed',
                accept: 'text/html',
                authorization: 'Bearer app-own-token',
            },
            HOST,
        );
        expect(out).toEqual({
            cookie: 'a=1',
            accept: 'text/html',
            authorization: 'Bearer app-own-token',
            'x-forwarded-proto': 'https',
            'x-forwarded-host': HOST,
            'x-kodus-preview': '1',
        });
    });

    it('drops an app Set-Cookie with a Domain and adds frame-ancestors, noindex and HSTS', () => {
        const { headers, droppedCookies } = previewResponseHeaders({
            'set-cookie': ['sid=1; Path=/; HttpOnly', 'wide=1; Domain=preview.example; Path=/'],
            'content-security-policy': "default-src 'self'",
            'content-type': 'text/html',
            connection: 'close',
        });
        expect(droppedCookies).toBe(1);
        expect(headers['set-cookie']).toEqual(['sid=1; Path=/; HttpOnly']);
        expect(headers['content-security-policy']).toEqual(["default-src 'self'", "frame-ancestors 'self'"]);
        expect(headers['x-frame-options']).toBe('SAMEORIGIN');
        expect(headers['x-robots-tag']).toBe('noindex, nofollow');
        expect(headers['strict-transport-security']).toContain('max-age=31536000');
        expect(headers.connection).toBeUndefined();
    });

    it('drops a Domain attribute however a browser would still read it: spaces or a tab around the name, any case, no value (#8)', () => {
        const wide = ['a=1; Domain =preview.example', 'b=1; Path=/; domain= preview.example', 'c=1;DOMAIN\t=preview.example', 'd=1; Path=/; Domain', 'e=1; \tdOmAiN=.preview.example; Secure'];
        const kept = ['domain=1; Path=/', 'f=1; Path=/; X-Domain=preview.example', 'g=1; Path=/domain=x'];
        const { headers, droppedCookies } = previewResponseHeaders({ 'set-cookie': [...wide, ...kept] });
        expect(droppedCookies).toBe(wide.length);
        expect(headers['set-cookie']).toEqual(kept);
    });
});
