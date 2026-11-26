import type { ExecRequest } from '@libs/runtime/environment';

import { FakeSuiteCell, SuiteClock, type FakeSuiteWorld } from '../suite/testing';
import { checkSuite, SUITE_CHECK_MIN_MS } from './suite-check';

// The setup runs the recipe's suite on one spec in the service it names, so a recipe whose app boots but whose suite
// cannot run (kr-mono on dev: the suite's image held no spec, every shard of every Run was infra) fails in the setup,
// on the recipe's account, with the runner's own words for Kody's author.

const RECIPE = (suite = '  service: e2e\n') =>
    'version: 1\nservices:\n  compose:\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n' +
    `suite:\n  runner: cypress\n  command: fake-runner --specs "{specs}"\n  specs: cypress/e2e/**/*.cy.ts\n${suite}  results:\n    junit: results/*.xml\n`;
const NO_SUITE = 'version: 1\nservices:\n  compose:\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n';
const MIN = 60_000;

/** A claim of the fake cell whose `find` answers `listing` (the files the suite's service holds). */
async function world(over: { listing?: string; findExit?: number; specs?: FakeSuiteWorld['specs']; log?: string; refusesService?: boolean } = {}) {
    const clock = new SuiteClock();
    const cell = new FakeSuiteCell(clock, { specs: over.specs ?? {}, ...(over.log ? { log: over.log } : {}), ...(over.refusesService ? { refusesService: true } : {}) });
    const claim = await cell.acquire({ organizationId: 'org-1', environmentId: 'env-1', ref: { side: 'base', sha: 'a'.repeat(40) }, consumer: 'setup', idempotencyKey: 'setup:k' } as never);
    const lists: ExecRequest[] = [];
    const env = {
        exec: async (claimId: string, req: ExecRequest) => {
            if (!req.stepId.endsWith(':suite-list')) return cell.exec(claimId, req);
            lists.push(req);
            if (over.refusesService) return { code: 'exec_service_unavailable' as const };
            return { stepId: req.stepId, exitCode: over.findExit ?? 0, stdout: over.listing ?? '', stderr: over.findExit ? "find: 'cypress/e2e': No such file or directory" : '', truncated: false, durationMs: 1, transport: 'ok' as const };
        },
    };
    const claimId = 'claimId' in claim ? claim.claimId : '';
    const run = (recipe: string | null, budgetMs = 30 * MIN) => checkSuite({ env, claimId, key: 'setup-k', recipe, budgetMs, now: clock.now, sleep: clock.sleep });
    return { cell, run, lists };
}

describe("the setup's check that the recipe's suite runs", () => {
    it('runs one spec of the suite in the service the recipe names, and a spec that ran is a suite that runs, red or green', async () => {
        const w = await world({ listing: 'cypress/e2e/b.cy.ts\ncypress/e2e/a.cy.ts\ncypress/support/e2e.ts\n', specs: { 'cypress/e2e/a.cy.ts': { pr: [{ fail: 'expected 3 rows' }], main: [{ fail: 'expected 3 rows' }] } } });
        const out = await w.run(RECIPE());
        expect(out).toEqual({ state: 'done', detail: 'cypress/e2e/a.cy.ts ran in service e2e (1 result file)' });
        expect(w.lists[0]).toMatchObject({ service: 'e2e', command: "find 'cypress/e2e' -type f -not -path '*/node_modules/*'" });
        expect(w.cell.starts.map((s) => s.specs)).toEqual([['cypress/e2e/a.cy.ts']]);
        expect(w.cell.execServices.every((e) => e.service === 'e2e')).toBe(true);
    });

    it("fails on the recipe's account when the suite's service holds no spec, naming the glob and the service", async () => {
        const w = await world({ findExit: 1 });
        const out = await w.run(RECIPE());
        expect(out).toMatchObject({ state: 'failed', blocker: { kind: 'toolchain', signature: 'suite_unrunnable' } });
        const message = out.state === 'failed' ? out.blocker.message : '';
        expect(message).toContain('service e2e holds no file matching suite.specs (cypress/e2e/**/*.cy.ts)');
        expect(message).toContain("find: 'cypress/e2e': No such file or directory");
        expect(w.cell.starts).toEqual([]);
    });

    it("fails with the runner's own words when it leaves no result file", async () => {
        const w = await world({
            listing: 'cypress/e2e/a.cy.ts\n',
            specs: { 'cypress/e2e/a.cy.ts': { main: ['crash'] } },
            log: '\x1B[31mYour supportFile is missing or invalid: cypress/support/e2e.ts\x1B[39m',
        });
        const out = await w.run(RECIPE());
        expect(out).toMatchObject({ state: 'failed', blocker: { signature: 'suite_unrunnable' } });
        const lines = out.state === 'failed' ? out.blocker.message.split('\n') : [];
        expect(lines[0]).toMatch(/^suite\.command on cypress\/e2e\/a\.cy\.ts in service e2e left no result file matching suite\.results \(results\/\*\.xml\)/);
        expect(lines).toContain('Your supportFile is missing or invalid: cypress/support/e2e.ts');
    });

    it('says nothing about the recipe when it cannot ask: no suite, a cell that cannot exec in a service, too little time left', async () => {
        expect(await (await world()).run(NO_SUITE)).toEqual({ state: 'skipped', detail: 'the recipe declares no suite' });
        expect(await (await world({ refusesService: true })).run(RECIPE())).toMatchObject({ state: 'skipped' });
        const late = await world({ listing: 'cypress/e2e/a.cy.ts\n' });
        expect(await late.run(RECIPE(), SUITE_CHECK_MIN_MS - 1)).toMatchObject({ state: 'skipped' });
        expect(late.lists).toEqual([]);
    });

    it('a spec still running at the bound is no verdict', async () => {
        const w = await world({ listing: 'cypress/e2e/a.cy.ts\n', specs: { 'cypress/e2e/a.cy.ts': { ms: 20 * MIN } } });
        expect(await w.run(RECIPE(), 3 * MIN)).toMatchObject({ state: 'skipped', detail: expect.stringContaining('did not finish') });
    });
});
