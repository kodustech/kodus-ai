import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runFleetCommand } from './fleet-command';
import type { AppliedPool, PoolApplyOutcome, PoolSpecWriter } from './pool-apply';

// `runtime-fleet apply -f <file|dir> [--dry-run]`, the operator's one way to create or change a pool
// (docs/runtime/host-providers.md §5.2): from the deploy pipeline, against the Runtime database.

const POOLS = `kind: HostClass
name: boat-large-cell
provider: boat
boat: { type: large, base: kodus-cell-r42-gvisor }
---
kind: HostPool
name: boat-eu-perrun
scope: kodus
provider: boat
lifecycle: perRun
hostClass: boat-large-cell
admission: { allowOrgs: [org-kodus] }
`;

class RecordingWriter implements PoolSpecWriter {
    readonly applied: AppliedPool[][] = [];
    closed = false;
    async apply(pools: AppliedPool[]): Promise<PoolApplyOutcome[]> {
        this.applied.push(pools);
        return pools.map((p) => ({ poolId: p.poolId, action: 'created' as const, specHash: p.specHash }));
    }
    async close() {
        this.closed = true;
    }
}

function run(argv: string[]) {
    const writer = new RecordingWriter();
    const out: string[] = [];
    const err: string[] = [];
    const deps = { writer: async () => writer, out: (l: string) => out.push(l), err: (l: string) => err.push(l), allowFake: false };
    return { writer, out, err, code: runFleetCommand(argv, deps) };
}

const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-pools-'));
    mkdirSync(join(d, 'boat'));
    return d;
};

describe('runtime-fleet apply', () => {
    it("writes every pool of a folder's files, and says what each became", async () => {
        const d = dir();
        writeFileSync(join(d, 'boat', 'eu.yaml'), POOLS);
        writeFileSync(join(d, 'README.md'), 'not a pool file');
        const r = run(['apply', '-f', d]);
        expect(await r.code).toBe(0);
        expect(r.writer.applied.map((ps) => ps.map((p) => p.poolId))).toEqual([['boat-eu-perrun']]);
        expect(r.out).toEqual([expect.stringMatching(/^created boat-eu-perrun \(spec [0-9a-f]{16}\)$/)]);
        expect(r.writer.closed).toBe(true);
    });

    it('a file with one bad document writes nothing and fails, naming the file and the problem', async () => {
        const d = dir();
        writeFileSync(join(d, 'eu.yaml'), POOLS);
        writeFileSync(join(d, 'us.yaml'), POOLS.replace('boat-eu-perrun', 'boat-us-perrun').replace('hostClass: boat-large-cell', 'hostClass: boat-xlarge'));
        const r = run(['apply', '-f', d]);
        expect(await r.code).toBe(1);
        expect(r.writer.applied).toEqual([]);
        expect(r.err.join('\n')).toMatch(/us\.yaml#2: .*boat-xlarge/);
    });

    it('--dry-run checks the files and writes nothing', async () => {
        const d = dir();
        writeFileSync(join(d, 'eu.yml'), POOLS);
        const r = run(['apply', '--dry-run', '-f', d]);
        expect(await r.code).toBe(0);
        expect(r.writer.applied).toEqual([]);
        expect(r.out).toEqual([expect.stringMatching(/^valid boat-eu-perrun \(spec [0-9a-f]{16}\)$/)]);
    });

    it('a YAML file that does not parse, a path that does not exist, or no -f at all is refused with the usage', async () => {
        const d = dir();
        writeFileSync(join(d, 'broken.yaml'), 'kind: [HostPool');
        for (const argv of [['apply', '-f', join(d, 'broken.yaml')], ['apply', '-f', join(d, 'missing')], ['apply'], ['destroy-everything']]) {
            const r = run(argv);
            expect(await r.code).not.toBe(0);
            expect(r.writer.applied).toEqual([]);
            expect(r.err.length).toBeGreaterThan(0);
        }
    });
});
