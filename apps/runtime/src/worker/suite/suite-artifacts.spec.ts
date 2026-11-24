import { suiteArtifactKey } from '@libs/runtime/contracts/evidence';
import type { ArtifactFile } from '@libs/runtime/suite';

import { InMemoryEvidenceStore } from '../../shared/evidence/testing';
import type { Canary } from '../canary/canary';
import { type SuiteArtifactSource, SuiteArtifactKeeper } from './suite-artifacts';
import { ZIP_SCAN_LIMITS } from './zip-scan';
import { buildZip } from './zip-testing';

// docs/runtime/e2e-suites.md section 7 (build-plan step 18): the artifacts of failed specs become evidence, redacted like all
// evidence, watched for canaries, within a byte budget; those of passed specs are never even read off the host.

const specs = ['cypress/e2e/cart.cy.ts', 'cypress/e2e/profile.cy.ts'];
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const canary: Canary = { slot: 'npmrc', value: '//registry.example/:_authToken=kdcanary-9f8e7d6c5b4a3210', core: '9f8e7d6c5b4a3210' };

class FakeSource implements SuiteArtifactSource {
    readonly reads: string[] = [];
    listed = 0;
    constructor(
        private readonly files: Record<string, Buffer>,
        private readonly unreadable = new Set<string>(),
    ) {}
    async list(): Promise<ArtifactFile[]> {
        this.listed++;
        return Object.entries(this.files).map(([path, b]) => ({ path, bytes: b.length }));
    }
    async read(_claimId: string, path: string): Promise<Buffer | undefined> {
        this.reads.push(path);
        return this.unreadable.has(path) ? undefined : this.files[path];
    }
}

const input = (over: Partial<Parameters<SuiteArtifactKeeper['keep']>[0]> = {}): Parameters<SuiteArtifactKeeper['keep']>[0] => ({
    organizationId: 'org-a', suiteRunId: 'sr-1', side: 'pr', shard: 0, claimId: 'claim-1', dirs: ['cypress/screenshots', 'cypress/videos'], specs, failed: ['cypress/e2e/cart.cy.ts'], remainingBytes: 200 * 1024 * 1024, ...over,
});
const keyOf = (path: string, spec = 'cypress/e2e/cart.cy.ts') => suiteArtifactKey({ organizationId: 'org-a', suiteRunId: 'sr-1', side: 'pr', shard: 0, spec, name: path });

describe('keeping the artifacts of failed specs', () => {
    it('stores the files of a failed spec under their keys with their content type, and never reads those of a passed spec', async () => {
        const store = new InMemoryEvidenceStore();
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        const source = new FakeSource({ 'cypress/screenshots/cypress/e2e/cart.cy.ts/fail.png': png, 'cypress/screenshots/cypress/e2e/profile.cy.ts/ok.png': png });
        const out = await new SuiteArtifactKeeper({ source, store }).keep(input());
        expect(source.reads).toEqual(['cypress/screenshots/cypress/e2e/cart.cy.ts/fail.png']);
        const key = keyOf('cypress/screenshots/cypress/e2e/cart.cy.ts/fail.png');
        expect(store.objects.get(key)).toEqual({ body: png, contentType: 'image/png' });
        expect(out.artifacts).toEqual([{ spec: 'cypress/e2e/cart.cy.ts', name: 'cypress/screenshots/cypress/e2e/cart.cy.ts/fail.png', key, contentType: 'image/png', bytes: png.length }]);
        expect(out).toMatchObject({ keptBytes: png.length, leaked: false });
        expect(out.dropped).toEqual([{ path: 'cypress/screenshots/cypress/e2e/profile.cy.ts/ok.png', reason: 'passed_spec' }]);
    });

    it('redacts a secret in a text artifact before it is stored', async () => {
        const store = new InMemoryEvidenceStore();
        const source = new FakeSource({ 'cypress/screenshots/cypress/e2e/cart.cy.ts/out.log': Buffer.from(`aws_access_key_id = ${AWS_KEY}\nrequest failed\n`) });
        await new SuiteArtifactKeeper({ source, store }).keep(input());
        const stored = [...store.objects.values()][0].body.toString('utf8');
        expect(stored).not.toContain(AWS_KEY);
        expect(stored).toContain('request failed');
    });

    it('a canary in a text artifact is stored redacted and says the suite leaked: the run halts', async () => {
        const store = new InMemoryEvidenceStore();
        const source = new FakeSource({ 'cypress/screenshots/cypress/e2e/cart.cy.ts/out.log': Buffer.from(`token ${canary.value} seen\n`) });
        const out = await new SuiteArtifactKeeper({ source, store }).keep(input({ canaries: [canary] }));
        expect(out.leaked).toBe(true);
        const stored = [...store.objects.values()][0].body.toString('utf8');
        expect(stored).not.toContain(canary.core);
        expect(stored).toContain('[redacted]');
    });

    it('keeps only what fits in the budget left, and reports the bytes it kept so the next shard has the rest', async () => {
        const store = new InMemoryEvidenceStore();
        const files = Object.fromEntries(['a', 'b', 'c'].map((n) => [`cypress/screenshots/cypress/e2e/cart.cy.ts/${n}.png`, Buffer.alloc(1000, n)]));
        const out = await new SuiteArtifactKeeper({ source: new FakeSource(files), store }).keep(input({ remainingBytes: 2500 }));
        expect(out.artifacts.map((a) => a.name.split('/').pop())).toEqual(['a.png', 'b.png']);
        expect(out.keptBytes).toBe(2000);
        expect(out.dropped).toEqual([{ path: 'cypress/screenshots/cypress/e2e/cart.cy.ts/c.png', reason: 'budget' }]);
    });

    it('a file that cannot be read, or a store that fails, drops that file and keeps the others', async () => {
        const store = new InMemoryEvidenceStore();
        const put = store.put.bind(store);
        store.put = async (key, body, type) => {
            if (key === keyOf('cypress/screenshots/cypress/e2e/cart.cy.ts/c.png')) throw new Error('disk');
            return put(key, body, type);
        };
        const files = Object.fromEntries(['a', 'b', 'c'].map((n) => [`cypress/screenshots/cypress/e2e/cart.cy.ts/${n}.png`, Buffer.alloc(10, n)]));
        const source = new FakeSource(files, new Set(['cypress/screenshots/cypress/e2e/cart.cy.ts/a.png']));
        const out = await new SuiteArtifactKeeper({ source, store }).keep(input());
        expect(out.artifacts.map((a) => a.name.split('/').pop())).toEqual(['b.png']);
        expect(out.dropped.map((d) => [d.path.split('/').pop(), d.reason])).toEqual([['a.png', 'read_failed'], ['c.png', 'store_failed']]);
    });

    it('with no failed spec it lists nothing and reads nothing', async () => {
        const source = new FakeSource({ 'cypress/screenshots/cypress/e2e/cart.cy.ts/a.png': Buffer.alloc(10) });
        const out = await new SuiteArtifactKeeper({ source, store: new InMemoryEvidenceStore() }).keep(input({ failed: [] }));
        expect(out).toMatchObject({ artifacts: [], keptBytes: 0, leaked: false });
        expect(source.listed).toBe(0);
    });

    describe('a zip artifact (a trace) is scanned before it is stored', () => {
        const path = 'cypress/screenshots/cypress/e2e/cart.cy.ts/trace.zip';
        const keepZip = async (zip: Buffer, canaries: Canary[] = [canary]) => {
            const store = new InMemoryEvidenceStore();
            const out = await new SuiteArtifactKeeper({ source: new FakeSource({ [path]: zip }), store }).keep(input({ canaries }));
            return { store, out };
        };

        it('a canary in a network entry sets leaked and the zip is not stored', async () => {
            const { store, out } = await keepZip(buildZip([{ name: 'trace.network', data: Buffer.from(`{"auth":"${canary.value}"}`) }]));
            expect(out.leaked).toBe(true);
            expect(store.objects.size).toBe(0);
            expect(out.artifacts).toEqual([]);
        });

        it('a secret pattern in an entry drops the zip with secret_in_archive', async () => {
            const { store, out } = await keepZip(buildZip([{ name: 'trace.network', data: Buffer.from(`aws_access_key_id = ${AWS_KEY}`) }]));
            expect(out.leaked).toBe(false);
            expect(store.objects.size).toBe(0);
            expect(out.dropped).toEqual([{ path, reason: 'secret_in_archive' }]);
        });

        it('a clean zip is stored unchanged', async () => {
            const zip = buildZip([{ name: 'trace.trace', data: Buffer.from('{"type":"event"}\n') }]);
            const { store, out } = await keepZip(zip);
            expect(out.leaked).toBe(false);
            expect(store.objects.get(keyOf(path))).toEqual({ body: zip, contentType: 'application/zip' });
            expect(out.artifacts).toHaveLength(1);
        });

        it('a bomb, or a zip that cannot be read, is dropped with archive_unreadable and never stored', async () => {
            for (const zip of [buildZip([{ name: 'trace.trace', data: Buffer.alloc(ZIP_SCAN_LIMITS.entryBytes + 1, 0x61), declaredSize: 5 }]), Buffer.from('PK garbage')]) {
                const { store, out } = await keepZip(zip);
                expect(store.objects.size).toBe(0);
                expect(out.dropped).toEqual([{ path, reason: 'archive_unreadable' }]);
            }
        });
    });
});
