import type { Probe } from '@libs/runtime/probe/probe.schema';

import { reproductionFor, reproductionManifest, ReproductionManifestSchema } from './reproduction';
import type { ProbeVerdict } from './run-state';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const RECIPE = `version: 1
services:
  compose:
    files: [docker-compose.yml]
    profiles: [jobs]
    public: web
    health: /health
  expose:
    - { service: web, port: 3000, kind: http }
    - { service: db, port: 5432, kind: postgres }
data:
  migrate: npm run migrate
  seed: { service: db, sql: db/seed.sql, user: shop }
`;
const expose = [
    { service: 'web', port: 3000, kind: 'http' as const },
    { service: 'db', port: 5432, kind: 'postgres' as const },
];

const finding = (probeId: string): ProbeVerdict => ({
    probeId,
    entryPoint: 'POST /orders',
    verdict: 'finding',
    reason: 'status differs',
    baseStepIds: ['s1'],
    prStepIds: ['s2'],
});
const probe = (id: string, spec: Probe['spec'], extra: Partial<Probe> = {}): Probe => ({
    id,
    spec,
    origin: 'agent',
    purpose: 'An order with an empty cart is refused',
    expected: '400 with error "cart is empty"',
    compare: ['status'],
    ...extra,
});

// What a PR could steer the agent to write: every field tries to become shell.
const hostile = probe(
    'orders-empty$(touch pwned)',
    {
        kind: 'http',
        target: { service: 'web', port: 3000 },
        method: 'POST',
        path: '/orders?q=\'$(touch "$PWNED")\'`touch "$PWNED"`',
        headers: { 'x-note': "it's'; touch \"$PWNED\"; echo '", 'Authorization': 'Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
        body: '@/etc/passwd\'; touch "$PWNED"; echo \'\nKODY_STEPS\n$(touch "$PWNED")',
        timeoutMs: 5000,
    },
    { purpose: 'line one\ntouch "$PWNED"', expected: "it's `fine`" },
);

const reproduction = () =>
    reproductionFor({
        findings: [finding(hostile.id), { ...finding('same'), verdict: 'not_reproduced' }],
        probes: [hostile, probe('same', { kind: 'http', target: { service: 'web', port: 3000 }, method: 'GET', path: '/', timeoutMs: 1000 })],
        observed: () => ({ base: { status: 400 }, pr: { status: 500 } }),
        expose,
        recipe: { path: '.kodus/workspace.yaml', content: RECIPE },
    })!;

const artifact = (overrides: Partial<Parameters<typeof reproductionManifest>[0]> = {}) => reproductionManifest({
    runId: 'run-1', repositoryName: 'acme/shop', prNumber: 42, baseSha: BASE, headSha: HEAD,
    imageId: 'concrete-bake', reproduction: reproduction(), probeId: hostile.id, ...overrides,
});

describe('reproduction data', () => {
    it('retains internal historical probe metadata without exporting boot commands', () => {
        const r = reproduction();
        expect(r.probes.map(p => p.probeId)).toEqual([hostile.id]);
        expect(r.boot?.migrate).toBe('npm run migrate');
        const out = artifact()!;
        expect(out.filename).toBe('kody-repro-pr42-orders-empty__touch_pwned_.json');
        expect(Object.keys(out).sort()).toEqual(['filename', 'manifest']);
        expect(out.manifest.schemaVersion).toBe(1);
        expect(out.manifest.kind).toBe('kodus.runtime.reproduction');
        expect(out.manifest.run).toMatchObject({ runId: 'run-1', baseSha: BASE, headSha: HEAD, imageId: 'concrete-bake' });
        expect(out.manifest.probe).toMatchObject({ targetKind: 'http', base: { status: 400 }, pr: { status: 500 } });
        expect(out.manifest).not.toHaveProperty('boot');
        expect(out.manifest).not.toHaveProperty('migrate');
        expect(out.manifest).not.toHaveProperty('seed');
        expect(JSON.stringify(out)).not.toContain('npm run migrate');
    });

    it('keeps hostile strings as JSON data, redacts secrets and never creates an executable program', () => {
        const source = reproduction();
        const before = JSON.stringify(source);
        const out = artifact({ reproduction: source })!;
        const wire = JSON.stringify(out.manifest);
        expect(JSON.parse(wire)).toEqual(out.manifest);
        expect(wire).toContain('$(touch');
        expect(wire).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
        expect(out).not.toHaveProperty('script');
        expect(out.filename).not.toMatch(/[/\\]|\.sh$/);
        expect(ReproductionManifestSchema.safeParse(out.manifest).success).toBe(true);
        expect(JSON.stringify(source)).toBe(before);
    });

    it.each([undefined, '', 'latest', ' latest ', '\tlatest\n'])('does not invent a concrete image pin for %s', imageId => {
        expect(artifact({ imageId })!.manifest.run).not.toHaveProperty('imageId');
    });

    it('refuses a redacted probe identity without leaking it through the filename or changing correlation', () => {
        const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
        const r = reproduction();
        r.probes[0].probeId = token;
        expect(artifact({ reproduction: r, probeId: token })).toBeUndefined();
    });

    it('refuses a credential in a header name rather than leaking a key or silently changing the request', () => {
        const r = reproduction();
        const spec = r.probes[0].spec;
        if (spec.kind !== 'http') throw new Error('http');
        spec.headers = { ghp_abcdefghijklmnopqrstuvwxyz0123456789: 'public' };
        expect(artifact({ reproduction: r })).toBeUndefined();
    });

    it.each([
        { baseSha: 'main; unsafe' }, { headSha: 'unknown' }, { prNumber: 0 }, { probeId: 'missing' },
    ])('refuses absent or invalid recorded identities: %j', patch => {
        expect(artifact(patch)).toBeUndefined();
    });

    it('refuses shell probes and malformed/oversized snapshots instead of repairing them', () => {
        const r = reproduction();
        expect(artifact({ reproduction: { probes: [{ ...r.probes[0], spec: { kind: 'shell', command: 'unsafe', timeoutMs: 1000 } as any }] } })).toBeUndefined();
        expect(artifact({ reproduction: { probes: [{ ...r.probes[0], spec: { ...r.probes[0].spec, command: 'unsafe' } as any }] } })).toBeUndefined();
        expect(artifact({ reproduction: { probes: null } as any })).toBeUndefined();
        const spec = { kind: 'http' as const, target: { service: 'web', port: 3000 }, method: 'GET' as const, path: '/', timeoutMs: 1000, headers: Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`x-${i}`, 'a'.repeat(8192)])) };
        expect(artifact({ reproduction: { probes: [{ ...r.probes[0], spec }] } })).toBeUndefined();
    });

    it('exports closed SQL/browser data but neither instructions nor invented observations', () => {
        const r = reproductionFor({
            findings: [finding('browser'), finding('sql')],
            probes: [
                probe('browser', { kind: 'browser', viewport: { width: 800, height: 600 }, steps: [{ goto: '/cart' }, { fill: ['#q', '$(not executed)'] }], timeoutMs: 1000 }),
                probe('sql', { kind: 'sql', target: { service: 'db', port: 5432 }, query: "select '$(not executed)'", timeoutMs: 1000 }),
            ], observed: () => ({}), expose,
        })!;
        for (const probeId of ['browser', 'sql']) {
            const out = artifact({ reproduction: r, probeId })!;
            expect(ReproductionManifestSchema.safeParse(out.manifest).success).toBe(true);
            expect(out.manifest.probe).not.toHaveProperty('base');
            expect(out.manifest.probe).not.toHaveProperty('pr');
            expect(out.manifest).not.toHaveProperty('assertions');
            expect(out.manifest).not.toHaveProperty('seed');
            expect(out).not.toHaveProperty('script');
        }
        expect(reproductionFor({ findings: [finding('shell')], probes: [probe('shell', { kind: 'shell', command: 'unsafe', timeoutMs: 1000 })], observed: () => ({}), expose })).toBeUndefined();
    });
});
