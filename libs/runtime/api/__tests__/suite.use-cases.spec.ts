import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { InMemoryRunTargetStore } from '@libs/runtime-publish/testing';
import { suiteRunIdOfRun } from '@libs/runtime/contracts/derive-id';
import { RuntimeSuiteRetriedSchema, RuntimeSuiteSelectionChangedSchema } from '@libs/runtime/contracts/runtime-commands';

import { RuntimeEnvironmentMembers } from '../application/environment-members.service';
import { RuntimeRunAccessService } from '../application/run-access.service';
import { RuntimeSuiteInputs } from '../application/suite-inputs.service';
import { RuntimeSuiteRetrier } from '../application/suite-retrier.service';
import { RuntimeSuiteSelection } from '../application/suite-selection.service';
import { GetRuntimeEnvironmentSuiteUseCase, GetRuntimeRunSuiteArtifactUseCase, GetRuntimeRunSuiteUseCase, ResumeSuiteSelectionUseCase, RetryRuntimeRunSuiteUseCase } from '../application/use-cases/suite.use-cases';
import type { ProductEnvironment, RuntimeGitPort } from '../domain/ports';
import type { RuntimeSuiteReader, StoredSelectionState, StoredSuiteResultRecord, StoredSuiteRun } from '../domain/suite';
import { clock, config, FakeOutbox, NOW, openSealed, ORG, OTHER_ORG, OTHER_REPO, REPO, realAuthorization, run, storeWith, TEAM, user } from './fixtures';

jest.mock('@libs/core/log/logger', () => ({ createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));

// docs/runtime/e2e-suites.md sections 10, 11 and 13: the suite's routes. Every one loads the Run (or the environment) first and answers
// another organization's object as not found; "Re-run failed" and "Resume selection" are commands on the outbox, never a write to a Runtime table.

const owner = user(Role.OWNER);
const repoAdmin = user(Role.REPO_ADMIN);
const contributor = user(Role.CONTRIBUTOR);
const outsider = user(Role.OWNER, { org: OTHER_ORG, uuid: 'outsider' });
const MAIN = 'd'.repeat(40);
const HEAD = 'a'.repeat(40);
const SUITE_YML = 'version: 1\nsuite:\n  runner: playwright\n  command: npx playwright test {specs} --reporter=junit\n  cwd: apps/web\n  specs: "e2e/**/*.spec.ts"\n  shards: 3\n  gate: strict\n  results: { junit: "results/*.xml" }\n';

const RUN = run({ runId: 'run-1', environmentId: 'env-1', state: 'regression', finishedAt: '2026-10-29T11:10:00.000Z' });
const SUITE_ID = suiteRunIdOfRun(ORG, RUN.runId);

const result = (spec: string, status: string, over: Partial<StoredSuiteResultRecord> = {}): StoredSuiteResultRecord => ({ phase: 'shard', shard: 0, spec, status, durationMs: 1000, tests: [], artifacts: [], ...over });
function stored(over: { run?: Partial<StoredSuiteRun['run']>; results?: StoredSuiteResultRecord[]; org?: string } = {}): StoredSuiteRun {
    return {
        run: { suiteRunId: SUITE_ID, organizationId: over.org ?? ORG, environmentId: 'env-1', repositoryId: REPO, mode: 'run', state: 'failed', prNumber: 7, prSha: HEAD, mergeBase: MAIN, mainSha: MAIN, requestedAt: '2026-10-29T11:00:00.000Z', finishedAt: '2026-10-29T11:08:00.000Z', ...over.run },
        shards: [{ shard: 0, specs: ['a.spec.ts', 'b.spec.ts'] }],
        results: over.results ?? [result('a.spec.ts', 'failed', { artifacts: [{ name: 'trace.zip', key: `${ORG}/${SUITE_ID}/pr/abc/suite-artifact`, contentType: 'application/zip', bytes: 10 }] }), result('b.spec.ts', 'passed')],
    };
}

class FakeSuiteReader implements RuntimeSuiteReader {
    runs: StoredSuiteRun[] = [];
    selection: StoredSelectionState = { off: false, fullPrsLeft: 0 };
    reads: string[] = [];
    async get(organizationId: string, suiteRunId: string) {
        this.reads.push(`${organizationId}/${suiteRunId}`);
        return this.runs.find((r) => r.run.organizationId === organizationId && r.run.suiteRunId === suiteRunId) ?? null;
    }
    async selectionState() {
        return this.selection;
    }
    async liveRunAfter(organizationId: string, environmentId: string, prNumber: number, after: string) {
        return this.runs.some((r) => r.run.organizationId === organizationId && r.run.environmentId === environmentId && r.run.prNumber === prNumber && r.run.requestedAt > after && !r.run.finishedAt);
    }
    async lastBaseline() {
        return { sha: MAIN, specs: 24, passed: 22, failed: 2, finishedAt: '2026-10-29T10:00:00.000Z' };
    }
    async lastMiss() {
        return null;
    }
    async usageOfMonth() {
        return { rows: [], savings: null };
    }
}

const env = (patch: Partial<ProductEnvironment> = {}): ProductEnvironment => ({ environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', state: 'active', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...patch });

async function world(o: { suite?: StoredSuiteRun | null; recipe?: string | null; runs?: typeof RUN[]; env?: ProductEnvironment | null } = {}) {
    const reader = new FakeSuiteReader();
    if (o.suite !== null) reader.runs.push(o.suite ?? stored());
    const runs = await storeWith(...(o.runs ?? [RUN]));
    const authorization = realAuthorization([REPO]);
    const access = new RuntimeRunAccessService(runs as any, authorization);
    const outbox = new FakeOutbox();
    const targets = new InMemoryRunTargetStore();
    await targets.record({ runId: RUN.runId, attempt: 1, organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', platform: PlatformType.GITHUB, pullRequestNumber: 7, headSha: HEAD, fork: false });
    const git = { readFileAtCommit: async () => (o.recipe === undefined ? SUITE_YML : o.recipe) } as unknown as RuntimeGitPort;
    const issued: string[] = [];
    const inputs = new RuntimeSuiteInputs(git as any, { issue: async () => (issued.push('t'), `ghs_${issued.length}`) } as any, config(), { get: async () => ({ sha: MAIN }) } as any);
    const retrier = new RuntimeSuiteRetrier(git as any, inputs, outbox as any, clock, targets);
    const environments = { get: async (org: string, id: string) => (o.env === null ? null : [env()].find((e) => e.organizationId === org && e.environmentId === id) ?? null), findByRepository: async () => null } as any;
    const members = new RuntimeEnvironmentMembers(environments, { listByEnvironment: async () => [], listByRepository: async () => [] } as any);
    const selection = new RuntimeSuiteSelection(outbox as any, clock);
    return {
        reader,
        outbox,
        targets,
        issued,
        get: new GetRuntimeRunSuiteUseCase(access, reader),
        retry: new RetryRuntimeRunSuiteUseCase(access, reader, retrier),
        artifact: new GetRuntimeRunSuiteArtifactUseCase(access, reader, config(), clock),
        environmentSuite: new GetRuntimeEnvironmentSuiteUseCase(environments, authorization, members, reader, git as any, { get: async () => ({ sha: MAIN }) } as any, config()),
        resume: new ResumeSuiteSelectionUseCase(environments, authorization, members, selection),
    };
}

describe('GET /runtime/runs/:id/suite', () => {
    it('answers the Run\'s suite from the suite run the worker named for it', async () => {
        const w = await world();
        const view = await w.get.execute({ user: owner, runId: RUN.runId });
        expect(view).toMatchObject({ suiteRunId: SUITE_ID, mode: 'run', state: 'failed', mainSha: MAIN, canRetry: true });
        expect(w.reader.reads).toEqual([`${ORG}/${SUITE_ID}`]);
    });

    it('answers another organization\'s Run as not found, without reading its suite', async () => {
        const w = await world();
        await expect(w.get.execute({ user: outsider, runId: RUN.runId })).rejects.toBeInstanceOf(NotFoundException);
        expect(w.reader.reads).toEqual([]);
    });

    it('is not found for a Run that has no suite, and the suite of another organization is never read as this one\'s', async () => {
        await expect((await world({ suite: null })).get.execute({ user: owner, runId: RUN.runId })).rejects.toBeInstanceOf(NotFoundException);
        await expect((await world({ suite: stored({ org: OTHER_ORG }) })).get.execute({ user: owner, runId: RUN.runId })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is open to every role of the organization, as the Run page is', async () => {
        const w = await world();
        for (const u of [owner, repoAdmin, contributor]) await expect(w.get.execute({ user: u, runId: RUN.runId })).resolves.toMatchObject({ suiteRunId: SUITE_ID });
    });
});

describe('POST /runtime/runs/:id/suite/retry', () => {
    it('issues one suite_retried of scope failed with the actor and a sealed token per claim, and stores where the retry\'s check is written', async () => {
        const w = await world();
        const out = await w.retry.execute({ user: owner, runId: RUN.runId });
        expect(out.state).toBe('queued');
        const rows = w.outbox.rows.filter((r) => r.payload.event_name === 'runtime.suite.retried');
        expect(rows).toHaveLength(1);
        const { workflowType: _lane, ...body } = rows[0].payload.payload;
        const cmd = RuntimeSuiteRetriedSchema.parse(body);
        expect(cmd).toMatchObject({ suiteRunId: SUITE_ID, organizationId: ORG, scope: 'failed', requestedBy: { userId: owner.uuid }, repositoryFullName: 'acme/shop' });
        // The recipe says three shards: the listing, three shards, the fresh host and the main host.
        expect(cmd.moreRepoTokens).toHaveLength(5);
        expect(w.issued).toHaveLength(6);
        expect(openSealed(cmd.repoToken!, cmd.key)).toBe('ghs_1');
        // The retry is a suite run of its own: its check is written under its id, to the PR of the Run.
        const target = await w.targets.get(out.suiteRunId);
        expect(target).toMatchObject({ pullRequestNumber: 7, repositoryId: REPO, headSha: HEAD });
    });

    it('refuses a re-run while an earlier re-run of the same suite still runs, before any token is minted', async () => {
        const w = await world();
        const source = w.reader.runs[0].run;
        w.reader.runs.push({ ...stored(), run: { ...source, suiteRunId: 'retry-1', requestedAt: new Date(Date.parse(source.finishedAt!) + 60_000).toISOString(), finishedAt: undefined, state: 'running' } });
        await expect(w.retry.execute({ user: owner, runId: RUN.runId })).rejects.toThrow('A re-run of this suite is still running');
        expect(w.issued).toEqual([]);
        expect(w.outbox.rows).toEqual([]);
    });

    it('asking twice in the same minute is one retry', async () => {
        const w = await world();
        const a = await w.retry.execute({ user: owner, runId: RUN.runId });
        const b = await w.retry.execute({ user: owner, runId: RUN.runId });
        expect(b.suiteRunId).toBe(a.suiteRunId);
        const keys = new Set(w.outbox.rows.map((r) => r.payload.payload.key));
        expect(keys.size).toBe(1);
    });

    it('refuses while the suite still runs, when nothing is left to retry, and when the recipe no longer declares a suite', async () => {
        await expect((await world({ suite: stored({ run: { state: 'running', finishedAt: undefined } }) })).retry.execute({ user: owner, runId: RUN.runId })).rejects.toBeInstanceOf(ConflictException);
        await expect((await world({ suite: stored({ results: [result('a.spec.ts', 'passed')] }) })).retry.execute({ user: owner, runId: RUN.runId })).rejects.toBeInstanceOf(ConflictException);
        const noSuite = await world({ recipe: 'version: 1\n' });
        await expect(noSuite.retry.execute({ user: owner, runId: RUN.runId })).rejects.toBeInstanceOf(ConflictException);
        expect(noSuite.outbox.rows).toEqual([]);
        expect(noSuite.issued).toEqual([]);
    });

    it('is another organization\'s 404, and a reader who may not create Runs is refused before any token is minted', async () => {
        const w = await world();
        await expect(w.retry.execute({ user: outsider, runId: RUN.runId })).rejects.toBeInstanceOf(NotFoundException);
        await expect(w.retry.execute({ user: contributor, runId: RUN.runId })).rejects.toBeInstanceOf(ForbiddenException);
        // A repository admin retries the Runs of the repositories assigned to them only.
        const theirs = await world({ runs: [{ ...RUN, repositoryId: OTHER_REPO }] });
        await expect(theirs.retry.execute({ user: repoAdmin, runId: RUN.runId })).rejects.toBeInstanceOf(ForbiddenException);
        expect(w.issued).toEqual([]);
        expect(theirs.issued).toEqual([]);
        expect(w.outbox.rows).toEqual([]);
    });
});

describe('GET /runtime/runs/:id/suite/artifacts', () => {
    it('signs a short URL for an artifact the suite run stored for that spec, never a key the caller names', async () => {
        const w = await world();
        const out = await w.artifact.execute({ user: owner, runId: RUN.runId, spec: 'a.spec.ts', name: 'trace.zip' });
        expect(out.key).toBe(`${ORG}/${SUITE_ID}/pr/abc/suite-artifact`);
        expect(out.url).toContain('evidence.runtime.example.test');
        expect(new Date(out.expiresAt).getTime() - NOW.getTime()).toBeLessThanOrEqual(300_000);
        await expect(w.artifact.execute({ user: owner, runId: RUN.runId, spec: 'a.spec.ts', name: '../secret' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(w.artifact.execute({ user: outsider, runId: RUN.runId, spec: 'a.spec.ts', name: 'trace.zip' })).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('GET /runtime/environments/:id/suite', () => {
    it('reads what the recipe declares at the main commit, the last baseline and the selection state', async () => {
        const w = await world();
        const v = await w.environmentSuite.execute({ user: owner, environmentId: 'env-1' });
        expect(v.recipe).toEqual({ runner: 'playwright', specs: 'e2e/**/*.spec.ts', command: 'npx playwright test {specs} --reporter=junit', cwd: 'apps/web', results: 'results/*.xml', shards: 3, gate: 'strict', baseline: true });
        expect(v.lastBaseline).toMatchObject({ sha: MAIN, specs: 24, passed: 22, failed: 2 });
        expect(v.selection).toEqual({ enabled: true });
        // The deployment's default (RUNTIME_SUITE_CI) until the environment says otherwise.
        expect(v.ci).toEqual({ enabled: false, source: 'deployment' });
    });

    it('has no recipe section when the recipe declares no suite, and is another organization\'s 404', async () => {
        const w = await world({ recipe: 'version: 1\n' });
        expect((await w.environmentSuite.execute({ user: owner, environmentId: 'env-1' })).recipe).toBeUndefined();
        await expect(w.environmentSuite.execute({ user: outsider, environmentId: 'env-1' })).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('POST /runtime/environments/:id/suite/selection/resume', () => {
    it('asks the Runtime to turn selection on again through the outbox, and writes no Runtime table', async () => {
        const w = await world();
        await w.resume.execute({ user: owner, environmentId: 'env-1' });
        const [row] = w.outbox.rows;
        expect(row.payload.event_name).toBe('runtime.suite.selection_changed');
        const { workflowType: _lane, ...body } = row.payload.payload;
        expect(RuntimeSuiteSelectionChangedSchema.parse(body)).toMatchObject({ organizationId: ORG, environmentId: 'env-1', selection: 'on', requestedBy: { userId: owner.uuid } });
    });

    it('needs the right to manage the environment, and another organization\'s environment is 404', async () => {
        const w = await world();
        await expect(w.resume.execute({ user: contributor, environmentId: 'env-1' })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(w.resume.execute({ user: outsider, environmentId: 'env-1' })).rejects.toBeInstanceOf(NotFoundException);
        expect(w.outbox.rows).toEqual([]);
    });
});
