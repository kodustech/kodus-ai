import { sealSecret, type RuntimeRunRequested } from '@libs/runtime/run';

import { shopRunRequest } from '../../e2e/fixtures';
import { devSealKey } from '../../testing/dev-seal-key';
import { InMemorySuiteRuns } from './testing';
import type { SuiteServiceResult } from './suite-service';
import { SuiteRunStage } from './suite-stage';

// docs/runtime/e2e-suites.md sections 10.2 and 11: Run mode calls the same engine from the Run, as one step group. The stage
// turns the Run's request into the suite command, runs the service with the Run's own step runner and reads what the run stored.

const withSuite = (over: Partial<NonNullable<RuntimeRunRequested['suite']>> = {}): RuntimeRunRequested => {
    const req = shopRunRequest();
    return { ...req, suite: { mainSha: 'c'.repeat(40), repoToken: sealSecret('ghs_s0', devSealKey(), req.runId), moreRepoTokens: [sealSecret('ghs_s1', devSealKey(), req.runId)], changedFiles: ['src/a.ts'], removedFiles: ['e2e/old.cy.ts'], deltaFiles: ['src/a.ts'], ...over } };
};
const passthrough = <T>(_n: string, fn: () => Promise<T>) => fn();

async function world(result: SuiteServiceResult, classification?: unknown) {
    const runs = new InMemorySuiteRuns();
    const seen: any[] = [];
    const service = {
        run: async (cmd: any, step: any, opts?: any) => {
            seen.push({ cmd, step, opts });
            await runs.create({ suiteRunId: cmd.suiteRunId, organizationId: cmd.organizationId, environmentId: cmd.environmentId, repositoryId: cmd.repositoryId, mode: cmd.mode, prNumber: cmd.prNumber, prSha: cmd.prSha, mergeBase: cmd.mergeBase, mainSha: cmd.mainSha, requestedAt: new Date(cmd.requestedAt) });
            await runs.finish(cmd.organizationId, cmd.suiteRunId, (result as any).state ?? 'neutral', new Date(), classification ? { classification: classification as never } : {});
            return 'suiteRunId' in result ? { ...result, suiteRunId: cmd.suiteRunId } : result;
        },
    };
    return { stage: new SuiteRunStage(service, runs), seen };
}

describe('the suite stage of a Run', () => {
    it('is off for a request with no suite section, and runs nothing', async () => {
        const w = await world({ status: 'ran', suiteRunId: 's', state: 'passed', replayed: false });
        expect(await w.stage.run(shopRunRequest(), passthrough)).toEqual({ status: 'off' });
        expect(w.seen).toEqual([]);
    });

    it('asks the service for a Run-mode suite of this Run: its PR, the main commit, its tokens bound to the Run, and its files', async () => {
        const req = withSuite();
        const w = await world({ status: 'ran', suiteRunId: 's', state: 'passed', replayed: false });
        await w.stage.run(req, passthrough);
        const { cmd, step } = w.seen[0];
        expect(cmd).toMatchObject({
            mode: 'run', organizationId: req.organizationId, environmentId: req.environment.environmentId, repositoryId: req.repository.id, repositoryFullName: req.repository.fullName,
            prNumber: req.pullRequest.number, prSha: req.pullRequest.headSha, mergeBase: req.pullRequest.baseSha, mainSha: 'c'.repeat(40), key: req.runId, targetId: req.runId,
            repoToken: req.suite!.repoToken, moreRepoTokens: req.suite!.moreRepoTokens, changedFiles: ['src/a.ts'], removedFiles: ['e2e/old.cy.ts'], deltaFiles: ['src/a.ts'],
        });
        // The suite run has an id of its own, the same on a replay of the Run, and the Run's step runner carries it.
        expect(cmd.suiteRunId).toMatch(/^[0-9a-f-]{36}$/);
        expect(cmd.suiteRunId).not.toBe(req.runId);
        expect(step).toBe(passthrough);
        await w.stage.run(req, passthrough);
        expect(w.seen[1].cmd.suiteRunId).toBe(cmd.suiteRunId);
    });

    it("hands the Run's deadline to the service, so the suite ends within the Run's own time", async () => {
        const w = await world({ status: 'ran', suiteRunId: 's', state: 'passed', replayed: false });
        await w.stage.run(withSuite(), passthrough, { deadlineAt: '2026-11-23T12:40:00.000Z' });
        expect(w.seen[0].opts).toEqual({ deadlineAt: '2026-11-23T12:40:00.000Z' });
    });

    it("hands the service the Run's cancel signal", async () => {
        const w = await world({ status: 'ran', suiteRunId: 's', state: 'cancelled' as never, replayed: false });
        const signal = new AbortController().signal;
        await w.stage.run(withSuite(), passthrough, { cancellationSignal: () => signal });
        expect(w.seen[0].opts.cancellationSignal()).toBe(signal);
    });

    it('takes the true merge base and the drift the product counted when the request has them, and the PR base otherwise', async () => {
        const w = await world({ status: 'ran', suiteRunId: 's', state: 'passed', replayed: false });
        await w.stage.run(withSuite({ mergeBase: 'e'.repeat(40), mainBehind: 5 }), passthrough);
        expect(w.seen[0].cmd).toMatchObject({ mergeBase: 'e'.repeat(40), mainBehind: 5 });
        await w.stage.run(withSuite(), passthrough);
        expect(w.seen[1].cmd.mergeBase).toBe(shopRunRequest().pullRequest.baseSha);
        expect(w.seen[1].cmd).not.toHaveProperty('mainBehind');
    });

    it('answers the state of the run and the classification it stored', async () => {
        const classification = { tests: [{ spec: 'a.cy.ts', title: 't', class: 'regression', blocks: true, finding: true, baseDrift: 0 }], massFailure: false, requestTemplateBuild: false };
        const w = await world({ status: 'ran', suiteRunId: 's', state: 'failed', replayed: false }, classification);
        expect(await w.stage.run(withSuite(), passthrough)).toEqual({ status: 'ran', state: 'failed', classification });
    });

    it('answers unavailable when the suite could not start, and off when the environment has none', async () => {
        expect(await (await world({ status: 'unavailable', suiteRunId: 's', state: 'neutral', reason: 'template_missing' })).stage.run(withSuite(), passthrough)).toEqual({ status: 'unavailable', reason: 'template_missing' });
        expect(await (await world({ status: 'off', reason: 'no_suite' })).stage.run(withSuite(), passthrough)).toEqual({ status: 'off' });
    });
});
