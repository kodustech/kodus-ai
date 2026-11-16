import { readFileSync } from 'fs';
import { join } from 'path';

import { KODUS_EGRESS_DENY_CASES, KODUS_EGRESS_DENY_PATTERNS, matchesEgressPattern, RECOMMENDED_EGRESS, RECOMMENDED_EGRESS_VERSION } from './egress-catalog';

// The same file runs in apps/runtime-cell/internal/netguard/lists_test.go:
// one deny list for the API and the cell (G2, S-59), one recommended list.

const denied = (host: string) => KODUS_EGRESS_DENY_PATTERNS.some((p) => matchesEgressPattern(host, p));

describe('Kodus egress lists', () => {
    it('is byte-identical to the cell copy', () => {
        const ts = readFileSync(join(__dirname, 'egress-lists.json'));
        const go = readFileSync(join(__dirname, '../../../apps/runtime-cell/internal/netguard/egress-lists.json'));
        expect(go.equals(ts)).toBe(true);
    });

    it.each(KODUS_EGRESS_DENY_CASES.denied)('denies %s', (host) => {
        expect(denied(host)).toBe(true);
    });

    it.each(KODUS_EGRESS_DENY_CASES.allowed)('does not deny %s', (host) => {
        expect(denied(host)).toBe(false);
    });

    it('recommends no host the deny list refuses, no wildcard and only exact hosts', () => {
        expect(RECOMMENDED_EGRESS_VERSION).toBeGreaterThanOrEqual(1);
        for (const e of RECOMMENDED_EGRESS) {
            expect([e.host, denied(e.host)]).toEqual([e.host, false]);
            expect(e.host).not.toContain('*');
            expect(e.since).toBeLessThanOrEqual(RECOMMENDED_EGRESS_VERSION);
            expect(e.paths.length).toBeGreaterThan(0);
            for (const p of [...e.paths, ...(e.exceptPaths ?? [])]) expect(p.startsWith('/')).toBe(true);
        }
        expect(new Set(RECOMMENDED_EGRESS.map((e) => e.host)).size).toBe(RECOMMENDED_EGRESS.length);
    });

    it('keeps the write channels out: no API, no git push host, no user content host (§7)', () => {
        const hosts = RECOMMENDED_EGRESS.map((e) => e.host);
        for (const out of ['api.github.com', 'raw.githubusercontent.com', 'gist.github.com', 'uploads.github.com', 'upload.pypi.org']) expect(hosts).not.toContain(out);
        // github.com is only its release and archive downloads, never git or the web UI.
        expect(RECOMMENDED_EGRESS.find((e) => e.host === 'github.com')?.paths).toEqual(['/*/*/releases/download/', '/*/*/archive/']);
    });

    // kr-nextjs (2026-11-13): an app that imports next/font/google cannot run `next build` without them, so Kody's
    // recipe kept `next dev` and the browser probe tested the dev server. Approved by the owner on 2026-11-13.
    it('v2: Google Fonts, read-only: the stylesheet API under /css and the font files under /s/, reached by a build', () => {
        expect(RECOMMENDED_EGRESS_VERSION).toBeGreaterThanOrEqual(2);
        expect(RECOMMENDED_EGRESS.find((e) => e.host === 'fonts.googleapis.com')).toMatchObject({ tier: 'inspected', paths: ['/css'], build: 'passthrough', since: 2 });
        expect(RECOMMENDED_EGRESS.find((e) => e.host === 'fonts.gstatic.com')).toMatchObject({ tier: 'inspected', paths: ['/s/'], build: 'passthrough', since: 2 });
    });

    it('D1: cdn.sheetjs.com is inspected under /xlsx- only', () => {
        expect(RECOMMENDED_EGRESS.find((e) => e.host === 'cdn.sheetjs.com')).toMatchObject({ tier: 'inspected', paths: ['/xlsx-'] });
    });
});

describe('what an image build reaches uninspected', () => {
    it('only read-only CDNs: no registry that takes a publish, no git host, no image registry', () => {
        const build = RECOMMENDED_EGRESS.filter((e) => e.build === 'passthrough').map((e) => e.host);
        for (const h of ['registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'github.com', 'registry-1.docker.io', 'auth.docker.io']) expect(build).not.toContain(h);
        expect(build).toEqual(expect.arrayContaining(['cdn.sheetjs.com', 'dl-cdn.alpinelinux.org', 'deb.debian.org', 'files.pythonhosted.org']));
    });
});
