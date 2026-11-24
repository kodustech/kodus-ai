import type { AcquireRequest, Blocked, Claim, ExecRequest, StepResult } from '@libs/runtime/environment';

import { FakeSuiteDemand, SuiteClock } from './testing';
import { LIST_HOST_SHARD, TemplateSpecLister } from './spec-lister';

const MAIN = 'a'.repeat(40);
const ref = { organizationId: 'org-a', environmentId: 'env-1', suiteRunId: 'run-1', mainSha: MAIN };

const ok = (stdout: string, over: Partial<StepResult> = {}): StepResult => ({ stepId: 's', exitCode: 0, stdout, stderr: '', truncated: false, durationMs: 1, transport: 'ok', ...over });

function world(over: { stdout?: string; exec?: Partial<StepResult>; ready?: boolean; blocked?: boolean } = {}) {
    const clock = new SuiteClock();
    const demand = new FakeSuiteDemand(clock);
    const acquired: AcquireRequest[] = [];
    const commands: ExecRequest[] = [];
    const released: string[] = [];
    const env = {
        acquire: async (r: AcquireRequest) => {
            acquired.push(r);
            return over.blocked ? ({ status: 'blocked', blockers: [] } as Blocked) : ({ claimId: 'claim-list' } as Claim);
        },
        exec: async (_c: string, r: ExecRequest) => {
            commands.push(r);
            return ok(over.stdout ?? '', over.exec);
        },
        release: async (c: string) => void released.push(c),
    };
    const templates = { hasReady: async () => over.ready ?? true };
    return { lister: new TemplateSpecLister({ env, demand, templates, clock }), demand, acquired, commands, released };
}

describe('listing the spec files of a suite on a template host of main', () => {
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

    it('lists from the suite directory when the glob has no fixed directory', async () => {
        const w = world({ stdout: '  5 a.spec.ts\n  5 total\n' });
        await w.lister.list(ref, { specsGlob: '**/*.spec.ts' });
        expect(w.commands[0].command).toContain("find '.'");
        expect(w.commands[0]).not.toHaveProperty('cwd');
    });

    it('says the template is missing, and asks for nothing, when no template is ready', async () => {
        const w = world({ ready: false });
        expect(await w.lister.list(ref, { specsGlob: 'e2e/**/*.ts' })).toEqual({ status: 'unavailable', reason: 'template_missing' });
        expect(w.acquired).toEqual([]);
        expect(w.demand.requested).toEqual([]);
    });

    it('says no host came when the fleet failed the host or the claim is blocked, and never lists a half answer', async () => {
        const failed = world();
        failed.demand.failed.add(LIST_HOST_SHARD);
        expect(await failed.lister.list(ref, { specsGlob: 'e2e/**/*.ts' })).toEqual({ status: 'unavailable', reason: 'no_host' });
        expect(await world({ blocked: true }).lister.list(ref, { specsGlob: 'e2e/**/*.ts' })).toEqual({ status: 'unavailable', reason: 'no_host' });
        expect(await world({ stdout: '  1 a.ts\n', exec: { truncated: true } }).lister.list(ref, { specsGlob: 'e2e/**/*.ts' })).toEqual({ status: 'unavailable', reason: 'list_failed' });
        expect(await world({ exec: { exitCode: 1 } }).lister.list(ref, { specsGlob: 'e2e/**/*.ts' })).toEqual({ status: 'unavailable', reason: 'list_failed' });
    });

    it('refuses a glob directory with characters a shell would read', async () => {
        const w = world();
        expect(await w.lister.list(ref, { specsGlob: 'e2e;rm -rf/**/*.ts' })).toEqual({ status: 'unavailable', reason: 'list_failed' });
        expect(w.commands).toEqual([]);
    });
});
