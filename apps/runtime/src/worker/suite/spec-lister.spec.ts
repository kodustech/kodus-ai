import type { AcquireRequest, Blocked, Claim, ExecRequest, StepResult } from '@libs/runtime/environment';

import { FakeSuiteDemand, SuiteClock } from './testing';
import { LIST_HOST_SHARD, TemplateSpecLister } from './spec-lister';

const MAIN = 'a'.repeat(40);
const ref = { organizationId: 'org-a', environmentId: 'env-1', suiteRunId: 'run-1', mainSha: MAIN };

const ok = (stdout: string, over: Partial<StepResult> = {}): StepResult => ({ stepId: 's', exitCode: 0, stdout, stderr: '', truncated: false, durationMs: 1, transport: 'ok', ...over });

function world(over: { stdout?: string; exec?: Partial<StepResult>; ready?: boolean; blocked?: boolean; roomAfter?: number } = {}) {
    const clock = new SuiteClock();
    const demand = new FakeSuiteDemand(clock);
    const acquired: AcquireRequest[] = [];
    const commands: ExecRequest[] = [];
    const released: string[] = [];
    const env = {
        acquire: async (r: AcquireRequest) => {
            acquired.push(r);
            // The host's cell registered but has not told the hub its room yet: the first asks wait for room.
            if (over.roomAfter !== undefined && acquired.length <= over.roomAfter) return { status: 'blocked', blockers: [{ kind: 'resources', signature: 'no_capacity', message: 'host starting' }] } as Blocked;
            return over.blocked ? ({ status: 'blocked', blockers: [{ signature: 'capacity_wait' }] } as unknown as Blocked) : ({ claimId: 'claim-list' } as Claim);
        },
        exec: async (_c: string, r: ExecRequest) => {
            commands.push(r);
            return ok(over.stdout ?? '', over.exec);
        },
        release: async (c: string) => void released.push(c),
    };
    return { lister: new TemplateSpecLister({ env, demand, clock }), demand, acquired, commands, released };
}

describe('listing the spec files of a suite on a template host of main', () => {
    it('asks again while the host it waited for has not reported its room yet, then lists', async () => {
        const w = world({ stdout: '  120 e2e/a.spec.js\n', roomAfter: 2 });
        expect(await w.lister.list(ref, { specsGlob: 'e2e/*.spec.js' })).toEqual({ status: 'listed', specs: [{ path: 'e2e/a.spec.js', sizeBytes: 120 }] });
        expect(w.acquired).toHaveLength(3);
        expect(new Set(w.acquired.map((r) => r.idempotencyKey)).size).toBe(1);
    });

    it('acquires a suite claim on the template host at main, lists under the glob directory only, and releases it', async () => {
        const w = world({ stdout: '  120 cypress/e2e/a.cy.ts\n  300 cypress/e2e/sub/b.cy.ts\n  420 total\n' });
        const out = await w.lister.list(ref, { cwd: 'apps/dashboard', specsGlob: 'cypress/e2e/**/*.cy.ts' });
        expect(out).toEqual({ status: 'listed', specs: [{ path: 'cypress/e2e/a.cy.ts', sizeBytes: 120 }, { path: 'cypress/e2e/sub/b.cy.ts', sizeBytes: 300 }] });
        expect(w.acquired[0]).toMatchObject({ consumer: 'suite', ref: { side: 'base', sha: MAIN }, shard: LIST_HOST_SHARD, suiteRunId: 'run-1' });
        expect(w.commands[0]).toMatchObject({ cwd: 'apps/dashboard' });
        expect(w.commands[0].command).toContain("find 'cypress/e2e'");
        expect(w.commands[0].command).toContain('node_modules');
        expect(w.released).toEqual(['claim-list']);
        expect(w.demand.requested).toEqual([[LIST_HOST_SHARD]]);
    });

    // kr-mono on dev: the public service (api) is built with the repository's .dockerignore, which leaves cypress/ out, so
    // the find there failed and every baseline ended neutral; the suite's own service is where its specs are.
    it("lists in the suite's own service when the recipe names one", async () => {
        const w = world({ stdout: '  120 cypress/e2e/a.cy.ts\n' });
        await w.lister.list(ref, { specsGlob: 'cypress/e2e/**/*.cy.ts', service: 'e2e' });
        expect(w.commands[0]).toMatchObject({ service: 'e2e' });
        await world({ stdout: '  120 cypress/e2e/a.cy.ts\n' }).lister.list(ref, { specsGlob: 'cypress/e2e/**/*.cy.ts' }).then(() => undefined);
    });

    it('lists from the suite directory when the glob has no fixed directory', async () => {
        const w = world({ stdout: '  5 a.spec.ts\n  5 total\n' });
        await w.lister.list(ref, { specsGlob: '**/*.spec.ts' });
        expect(w.commands[0].command).toContain("find '.'");
        expect(w.commands[0]).not.toHaveProperty('cwd');
    });


    it('says no host came when the fleet failed the host or the claim is blocked, and never lists a half answer', async () => {
        const failed = world();
        failed.demand.failed.add(LIST_HOST_SHARD);
        expect(await failed.lister.list(ref, { specsGlob: 'e2e/**/*.ts' })).toEqual({ status: 'unavailable', reason: 'no_host' });
        expect(await world({ blocked: true }).lister.list(ref, { specsGlob: 'e2e/**/*.ts' })).toEqual({ status: 'unavailable', reason: 'no_host', blocker: 'capacity_wait' });
        expect(await world({ stdout: '  1 a.ts\n', exec: { truncated: true } }).lister.list(ref, { specsGlob: 'e2e/**/*.ts' })).toEqual({ status: 'unavailable', reason: 'list_failed' });
        expect(await world({ exec: { exitCode: 1 } }).lister.list(ref, { specsGlob: 'e2e/**/*.ts' })).toEqual({ status: 'unavailable', reason: 'list_failed' });
    });

    it('refuses a glob directory with characters a shell would read', async () => {
        const w = world();
        expect(await w.lister.list(ref, { specsGlob: 'e2e;rm -rf/**/*.ts' })).toEqual({ status: 'unavailable', reason: 'list_failed' });
        expect(w.commands).toEqual([]);
    });
});
