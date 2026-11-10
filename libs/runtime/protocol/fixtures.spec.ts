import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { decodeFrame, MAX_DEPTH, MAX_FRAME_BYTES, PROTOCOL_VERSION, protocolJsonSchemas } from './envelope';
import { CELL_FEATURES, HUB_ACCEPTED_FEATURES, hubAccepts, knownCellFeatures } from './messages';

// The same fixtures run in apps/runtime-cell/internal/protocol/fixtures_test.go:
// both decoders must accept the same frames with the same body, and refuse
// the same frames with the same code.

interface Fixture {
    name: string;
    frame?: string;
    message?: { body: unknown };
    expect: { ok: true; type: string } | { ok: false; code: string };
}

const dir = join(__dirname, 'fixtures');
const fixtures: Fixture[] = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));

describe('shared protocol fixtures', () => {
    it('has fixtures for both outcomes', () => {
        expect(fixtures.filter((f) => f.expect.ok).length).toBeGreaterThan(10);
        expect(fixtures.filter((f) => !f.expect.ok).length).toBeGreaterThan(10);
    });

    it.each(fixtures.map((f) => [f.name, f] as const))('%s', (_name, f) => {
        const raw = f.frame ?? JSON.stringify(f.message);
        const r = decodeFrame(raw);
        if (f.expect.ok) {
            expect(r).toMatchObject({ ok: true });
            if (!r.ok) return;
            expect(r.message.type).toBe(f.expect.type);
            expect(r.message.body).toEqual(f.message!.body);
        } else {
            expect(r).toMatchObject({ ok: false, code: (f.expect as { code: string }).code });
        }
    });
});

describe('hello features', () => {
    // The Go cell advertises protocol.Features(), checked against the same
    // fixture (features_test.go): a feature added on one side only fails a suite.
    it('are the ones the shared fixture names', () => {
        const f = fixtures.find((x) => x.name === 'hello-features-recipe-execution')!;
        expect((f.message!.body as { features: string[] }).features).toEqual([...CELL_FEATURES]);
    });

    it('keeps the names this hub knows, once each, and ignores a newer cell\'s', () => {
        expect(knownCellFeatures(['egressAllow', 'claimSize', 'someFutureField', 'claimSize', 'seedsCache'])).toEqual(['seedsCache', 'claimSize', 'egressAllow']);
        expect(knownCellFeatures(undefined)).toEqual([]);
    });

    it('a hub accepts only the cell-sent fields the cell named, and names nothing for an older cell', () => {
        expect(hubAccepts([...CELL_FEATURES])).toEqual(['readyBuildSteps', 'cellMemory', 'timedRequests', 'serviceLogs', 'dbEffects', 'outboundCalls', 'execCast', 'browser', 'browserExplore']);
        expect(hubAccepts(['serviceLogs', 'seedsCache'])).toEqual(['serviceLogs']);
        expect(hubAccepts(['seedsCache', 'claimSize'])).toEqual([]);
        expect(hubAccepts(undefined)).toEqual([]);
        expect(HUB_ACCEPTED_FEATURES.every((f) => (CELL_FEATURES as readonly string[]).includes(f))).toBe(true);
    });
});

describe('JSON Schema dump', () => {
    // The Go cell generates its types from this file (go generate ./internal/protocol).
    it('is the one checked in for the Go cell', () => {
        const file = join(__dirname, '../../../apps/runtime-cell/internal/protocol/schema/protocol.schema.json');
        const doc = { protocolVersion: PROTOCOL_VERSION, maxFrameBytes: MAX_FRAME_BYTES, maxDepth: MAX_DEPTH, schemas: protocolJsonSchemas() };
        // Stale: run libs/runtime/protocol/scripts/dump-json-schema.ts, then go generate ./internal/protocol.
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(doc)));
    });

    it('closes every tuple with items: false and minItems', () => {
        const tuples: any[] = [];
        const walk = (n: any) => {
            if (Array.isArray(n)) return n.forEach(walk);
            if (n && typeof n === 'object') {
                if (Array.isArray(n.prefixItems)) tuples.push(n);
                Object.values(n).forEach(walk);
            }
        };
        walk(protocolJsonSchemas());
        expect(tuples.length).toBeGreaterThan(0);
        for (const t of tuples) {
            expect(t.items).toBe(false);
            expect(t.minItems).toBe(t.prefixItems.length);
        }
    });
});
