import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { CheckConclusion, CheckStatus, type IChecksAdapter } from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { runtimeEnvelope } from '@libs/runtime/run';
import { RuntimeSuitePublishRequestedSchema, SUITE_PUBLISH_EVENT, suitePublishKey, type RuntimeSuitePublishRequested } from '@libs/runtime/run';
import type { SuiteReport } from '@libs/runtime/suite';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';

import type { RunTarget } from '../domain/run-target';
import { toPublishRepository } from '../infrastructure/integration-config-repository.resolver';
import { InMemoryCheckSlotStore, InMemoryPublicationStore, InMemoryRunTargetStore } from '../testing';
import { PublishSuiteCheckUseCase } from './publish-suite-check.use-case';

const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@libs/core/log/logger', () => ({ createLogger: () => logger }));

// docs/runtime/e2e-suites.md section 10.1: the suite gets its own check slot, `Kody Runtime e2e`, on the PR head, opened when the
// suite starts, closed with the conclusion and the annotations, which GitHub takes 50 a request.

const SUITE_ID = '0b9f4c1e-8d2a-4f6b-9a3c-1e2d3f4a5b6c';
const HEAD = 'a'.repeat(40);
const REQUESTED = '2026-11-23T12:00:00.000Z';
const target = (over: Partial<RunTarget> = {}): RunTarget => ({ runId: SUITE_ID, attempt: 1, organizationId: 'org-a', teamId: 'team-a', repositoryId: 'repo-1', repositoryName: 'widgets', repositoryFullName: 'acme/widgets', platform: PlatformType.GITHUB, pullRequestNumber: 42, headSha: HEAD, ...over });
const report = (over: Partial<SuiteReport> = {}): SuiteReport => ({
    state: 'failed', mode: 'ci', mainSha: 'b'.repeat(40), prSha: HEAD, selection: { mode: 'full', reason: 'map_missing', total: 10 },
    totals: { passed: 9, failed: 1, skipped: 0, notRun: 0 }, classes: { regression: 1, preExisting: 0, flaky: 0, unclassified: 0, infra: 0 },
    annotations: [{ path: 'cypress/e2e/a.cy.ts', line: 12, level: 'failure', title: 'works', message: 'expected 3' }], annotationsOmitted: 0, requestedAt: REQUESTED, ...over,
});
const finalMsg = (over: Partial<RuntimeSuitePublishRequested> = {}): RuntimeSuitePublishRequested => ({ suiteRunId: SUITE_ID, targetId: SUITE_ID, attempt: 1, key: suitePublishKey(SUITE_ID, 'final'), correlationId: `suite-${SUITE_ID}`, check: { status: 'completed', conclusion: 'failure' }, report: report(), ...over });
const runningMsg = (): RuntimeSuitePublishRequested => ({ ...finalMsg(), key: suitePublishKey(SUITE_ID, 'running'), check: { status: 'in_progress' }, report: report({ state: 'running', annotations: [], totals: { passed: 0, failed: 0, skipped: 0, notRun: 0 }, classes: { regression: 0, preExisting: 0, flaky: 0, unclassified: 0, infra: 0 } }) });
const onTheWire = (msg: unknown) => runtimeEnvelope(SUITE_PUBLISH_EVENT, { ...(msg as object), workflowType: WorkflowType.RUNTIME_PUBLISH }, 'msg-1');

type Out = { title: string; summary: string; annotations?: Array<{ path: string; startLine: number; level: string }> };
class FakeChecks implements IChecksAdapter {
    readonly runs = new Map<number, { name: string; headSha: string; status: CheckStatus; conclusion?: CheckConclusion; output: Out }>();
    readonly updates: Array<{ id: number; status?: CheckStatus; conclusion?: CheckConclusion; annotations: number }> = [];
    readonly statuses: any[] = [];
    checksApi = true;
    refuseUpdates = 0;
    private next = 900;
    async isChecksApiAvailable() { return this.checksApi; }
    async createCommitStatus(p: any) { this.statuses.push(p); return 'posted' as const; }
    async createCheckRun(p: any) {
        const id = this.next++;
        this.runs.set(id, { name: p.name, headSha: p.headSha, status: p.status, output: p.output });
        return id;
    }
    async updateCheckRun(p: any) {
        if (this.refuseUpdates > 0) { this.refuseUpdates--; return false; }
        const run = this.runs.get(Number(p.checkRunId));
        if (!run) return false;
        this.updates.push({ id: Number(p.checkRunId), status: p.status, conclusion: p.conclusion, annotations: p.output?.annotations?.length ?? 0 });
        Object.assign(run, { ...(p.status ? { status: p.status } : {}), ...(p.conclusion ? { conclusion: p.conclusion } : {}), ...(p.output ? { output: p.output } : {}) });
        return true;
    }
    async findCheckRun(p: any) { return [...this.runs].find(([, r]) => r.headSha === p.headSha && r.name === p.name && r.status !== CheckStatus.COMPLETED)?.[0] ?? null; }
}

async function setup(opts: { target?: Partial<RunTarget> | null; platform?: PlatformType } = {}) {
    const targets = new InMemoryRunTargetStore();
    if (opts.target !== null) await targets.record(target({ ...(opts.platform ? { platform: opts.platform } : {}), ...opts.target }));
    const publications = new InMemoryPublicationStore();
    const checks = new FakeChecks();
    const repos: Record<string, ReturnType<typeof toPublishRepository>> = { 'org-a/team-a/repo-1': toPublishRepository({ id: 'repo-1', name: 'widgets', full_name: 'acme/widgets' }) };
    const useCase = new PublishSuiteCheckUseCase(
        targets,
        publications,
        { resolve: async (o: any, id: string) => repos[`${o.organizationId}/${o.teamId}/${id}`] ?? null },
        { getTypeIntegration: async () => opts.platform ?? PlatformType.GITHUB } as any,
        { getAdapter: () => checks },
        'https://app.kodus.test',
        new InMemoryCheckSlotStore(),
    );
    return { useCase, checks, publications };
}

beforeEach(() => jest.clearAllMocks());

describe('PublishSuiteCheckUseCase', () => {
    it('opens the suite check on the PR head when the suite starts, and closes the same check with the verdict', async () => {
        const t = await setup();
        expect(await t.useCase.execute(onTheWire(runningMsg()))).toEqual({ outcome: 'published', key: suitePublishKey(SUITE_ID, 'running'), action: 'created' });
        expect([...t.checks.runs.values()]).toEqual([expect.objectContaining({ name: 'Kody Runtime e2e', headSha: HEAD, status: CheckStatus.IN_PROGRESS })]);
        expect(await t.useCase.execute(onTheWire(finalMsg()))).toEqual({ outcome: 'published', key: suitePublishKey(SUITE_ID, 'final'), action: 'updated' });
        const [run] = [...t.checks.runs.values()];
        expect(t.checks.runs.size).toBe(1);
        expect(run).toMatchObject({ status: CheckStatus.COMPLETED, conclusion: CheckConclusion.FAILURE });
        expect(run.output.title).toBe('1 regression · 9 specs passed');
        expect(run.output.annotations?.[0]).toMatchObject({ path: 'cypress/e2e/a.cy.ts', startLine: 12, level: 'failure' });
    });

    it('takes the conclusion from the report state: a neutral run is neutral whatever the message says', async () => {
        const t = await setup();
        await t.useCase.execute(onTheWire(finalMsg({ report: report({ state: 'neutral', classes: { regression: 0, preExisting: 0, flaky: 0, unclassified: 2, infra: 0 }, annotations: [] }), check: { status: 'completed', conclusion: 'success' } })));
        expect([...t.checks.runs.values()][0].conclusion).toBe(CheckConclusion.NEUTRAL);
    });

    it('sends annotations 50 a request: the first with the close, the rest in follow-up updates of the same check run', async () => {
        const t = await setup();
        const annotations = Array.from({ length: 120 }, (_, i) => ({ path: `s${i}.cy.ts`, line: 1, level: 'failure' as const, title: 't', message: 'm' }));
        await t.useCase.execute(onTheWire(finalMsg({ report: report({ annotations, classes: { regression: 120, preExisting: 0, flaky: 0, unclassified: 0, infra: 0 } }) })));
        expect(t.checks.updates.map((u) => u.annotations)).toEqual([50, 50, 20]);
        // The close carries the status and conclusion once; a follow-up never reopens or changes it.
        expect(t.checks.updates[0]).toMatchObject({ status: CheckStatus.COMPLETED, conclusion: CheckConclusion.FAILURE });
        expect(t.checks.updates.slice(1).every((u) => u.status === undefined && u.conclusion === undefined)).toBe(true);
        expect(new Set(t.checks.updates.map((u) => u.id)).size).toBe(1);
    });

    it('a delivery repeated after it was published does nothing', async () => {
        const t = await setup();
        await t.useCase.execute(onTheWire(finalMsg()));
        expect(await t.useCase.execute(onTheWire(finalMsg()))).toEqual({ outcome: 'duplicate', key: suitePublishKey(SUITE_ID, 'final') });
        expect(t.checks.runs.size).toBe(1);
    });

    it('a late "running" never moves a check the verdict already closed', async () => {
        const t = await setup();
        await t.useCase.execute(onTheWire(finalMsg()));
        const out = await t.useCase.execute(onTheWire(runningMsg()));
        expect(out).toMatchObject({ outcome: 'skipped' });
        expect([...t.checks.runs.values()][0].status).toBe(CheckStatus.COMPLETED);
    });

    it('posts the check as a commit status where the connection cannot create check runs', async () => {
        const t = await setup();
        t.checks.checksApi = false;
        expect(await t.useCase.execute(onTheWire(finalMsg()))).toMatchObject({ outcome: 'published' });
        expect(t.checks.statuses).toEqual([expect.objectContaining({ context: 'Kody Runtime e2e', sha: HEAD, conclusion: CheckConclusion.FAILURE, description: '1 regression · 9 specs passed' })]);
        expect(t.checks.runs.size).toBe(0);
    });

    it('names the check with the environment when the PR is in a repository that is a member of it', async () => {
        const t = await setup({ target: { workspace: [{ repositoryId: 'repo-primary', alias: 'demo-shop', baseSha: 'c'.repeat(40), headSha: 'd'.repeat(40), source: 'pr' as never }, { repositoryId: 'repo-1', alias: 'widgets', baseSha: 'c'.repeat(40), headSha: HEAD, source: 'pr' as never }] } });
        await t.useCase.execute(onTheWire(finalMsg()));
        expect([...t.checks.runs.values()][0].name).toBe('Kody Runtime e2e (demo-shop)');
    });

    it('a platform that refuses the close fails the delivery, so the broker tries again, and the claim is free for it', async () => {
        const t = await setup();
        await t.useCase.execute(onTheWire(runningMsg()));
        t.checks.refuseUpdates = 1;
        await expect(t.useCase.execute(onTheWire(finalMsg()))).rejects.toThrow();
        expect(await t.useCase.execute(onTheWire(finalMsg()))).toMatchObject({ outcome: 'published' });
    });

    describe('refusals', () => {
        it.each([
            ['a message that is not a suite publication', { nonsense: true }, 'invalid_message'],
            ['a key that does not name the phase', finalMsg({ key: 'something-else' }), 'key_mismatch'],
        ])('%s', async (_n, msg, reason) => {
            const t = await setup();
            expect(await t.useCase.execute(onTheWire(msg))).toMatchObject({ outcome: 'refused', reason });
            expect(t.checks.runs.size).toBe(0);
        });

        it('refuses when the product has no target for it, or the attempt differs, or the repository is not the org\'s', async () => {
            expect(await (await setup({ target: null })).useCase.execute(onTheWire(finalMsg()))).toMatchObject({ outcome: 'refused', reason: 'target_not_found' });
            expect(await (await setup()).useCase.execute(onTheWire(finalMsg({ attempt: 2 })))).toMatchObject({ outcome: 'refused', reason: 'attempt_mismatch' });
            expect(await (await setup({ target: { repositoryId: 'repo-other' } })).useCase.execute(onTheWire(finalMsg()))).toMatchObject({ outcome: 'refused', reason: 'repository_not_in_org' });
            expect(await (await setup({ platform: PlatformType.GITLAB, target: { platform: PlatformType.GITHUB } })).useCase.execute(onTheWire(finalMsg()))).toMatchObject({ outcome: 'refused', reason: 'platform_mismatch' });
        });

        it('refuses an event that is not the suite publication', async () => {
            const t = await setup();
            expect(await t.useCase.execute(runtimeEnvelope('runtime.publish.requested', { ...finalMsg(), workflowType: WorkflowType.RUNTIME_PUBLISH }, 'm'))).toMatchObject({ outcome: 'refused', reason: 'unexpected_event' });
        });
    });

    it('the schema the Runtime sends is the one it reads', () => {
        expect(RuntimeSuitePublishRequestedSchema.safeParse(finalMsg()).success).toBe(true);
    });
});
