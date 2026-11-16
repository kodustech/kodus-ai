import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { RuntimeRunRequestedSchema } from '@libs/runtime/run';

import { RuntimeEnvironmentMembers } from '../application/environment-members.service';
import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import { RuntimeRunEnqueuer } from '../application/runtime-run-enqueuer.service';
import { RuntimePullRequestTriggerUseCase } from '../application/use-cases/pull-request-trigger.use-case';
import { RuntimeWebhookReconciler, type WebhookReconcilerMetrics } from '../application/webhook-reconciler.service';
import type { OpenPullRequestSummary, PullRequestHead, RuntimeGitPort, RuntimeRepositorySettingsRecord } from '../domain/ports';
import { RECONCILE_MAX_ATTEMPTS, type WebhookReconcilerConfig } from '../domain/webhook-reconciler';
import { loadWebhookReconcilerConfig } from '../infrastructure/runtime-api.config';
import { BASE_SHA, clock, config, FakeOutbox, NOW, ORG, REPO, run, SECRET, SHA, storeWith, TEAM } from './fixtures';
import { InMemoryRunTargetStore } from '@libs/runtime-publish/testing';
import { InMemoryReconciledHeadStore } from '../testing';
import { type InMemoryRunProjectionStore } from '@libs/runtime/run/testing';

const HOUR = 3_600_000;
const NEW_SHA = 'c'.repeat(40);

const rules = (patch: Partial<RuntimeRepositorySettingsRecord> = {}): RuntimeRepositorySettingsRecord => ({
    repositoryId: REPO,
    pilot: true,
    whoCanAsk: 'writers',
    mode: 'rules',
    rules: [{ conditions: [{ field: 'changed_paths', matches: 'src/**' }] }],
    runOnAgentPullRequests: false,
    runOnNewPushes: true,
    ...patch,
});

const openPr = (patch: Partial<OpenPullRequestSummary> = {}): OpenPullRequestSummary => ({
    number: 7,
    headSha: SHA,
    draft: false,
    updatedAt: new Date(NOW.getTime() - HOUR).toISOString(),
    ...patch,
});

const on: WebhookReconcilerConfig = { ...loadWebhookReconcilerConfig({}), enabled: true };

/** What a database shared by every replica holds: the outbox, the publish targets, the Run projection and the ledger. */
async function shared(opts: { runs?: ReturnType<typeof run>[] } = {}) {
    return {
        outbox: new FakeOutbox(),
        targets: new InMemoryRunTargetStore(),
        projection: (await storeWith(...(opts.runs ?? []))) as InMemoryRunProjectionStore,
        ledger: new InMemoryReconciledHeadStore(() => NOW.getTime()),
    };
}

/** One product-worker replica: the real trigger behind the reconciler, the Git API and the stores faked. */
function replica(
    db: Awaited<ReturnType<typeof shared>>,
    opts: {
        config?: Partial<WebhookReconcilerConfig>;
        prs?: OpenPullRequestSummary[];
        head?: Partial<PullRequestHead>;
        settings?: RuntimeRepositorySettingsRecord[];
        settingsUpdatedAt?: string;
        setup?: { state: string; finishedAt?: string } | null;
        platform?: PlatformType;
        stopped?: boolean | Error;
        triggerThrows?: number;
        forkPolicy?: 'skip' | 'require_approval' | 'run';
    } = {},
) {
    const prs = opts.prs ?? [openPr()];
    const head: PullRequestHead = { headSha: prs[0]?.headSha ?? SHA, baseSha: BASE_SHA, fork: false, state: 'open', draft: false, ...opts.head };
    const git = {
        getPullRequestHead: jest.fn(async () => head),
        getPullRequestDiff: async () => ({ files: [{ path: 'src/orders/orders.controller.ts', patch: '@@ -1 +1 @@\n-a\n+b' }], truncated: false }),
        userCanWrite: async () => true,
        isOrganizationMember: async () => true,
        listOpenPullRequests: jest.fn(async () => prs),
    } as unknown as RuntimeGitPort & { listOpenPullRequests: jest.Mock; getPullRequestHead: jest.Mock };
    const env = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', state: 'active', createdAt: '', updatedAt: '', ...(opts.forkPolicy ? { forkPullRequests: opts.forkPolicy } : {}) };
    const settings = opts.settings ?? [rules()];
    // Each repository with a settings row is the primary of its own environment; REPO's is env-1.
    const environments = {
        findByRepository: async (org: string, repo: string) =>
            org !== ORG ? null : repo === REPO ? (env as any) : settings.some((s) => s.repositoryId === repo) ? ({ ...env, environmentId: `env-${repo}`, repositoryId: repo, repositoryName: `acme/${repo}` } as any) : null,
    };
    const setup = opts.setup === undefined ? { state: 'active', finishedAt: new Date(NOW.getTime() - 5 * 24 * HOUR).toISOString() } : opts.setup;
    const setups = { get: async (org: string) => (setup && org === ORG ? ({ ...setup, organizationId: ORG } as any) : null) };
    const platform = opts.platform ?? PlatformType.GITHUB;
    const enqueuer = new RuntimeRunEnqueuer(db.targets, db.outbox as any, { getTypeIntegration: async () => platform });
    const builder = new RuntimeRunRequestBuilder(
        git,
        { issue: async () => 'repo-token' },
        { get: async () => ({ environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, imageId: 'img-1', expose: [] }) },
        config({ runTokenSecret: SECRET }),
        clock,
    );
    const members = RuntimeEnvironmentMembers.primaryOnly(environments);
    const trigger = new RuntimePullRequestTriggerUseCase({ listRepositories: async () => settings }, environments, db.projection, git, builder, enqueuer, setups, undefined, members);
    let throwsLeft = opts.triggerThrows ?? 0;
    const execute = jest.fn(async (message: unknown, executeOpts?: { reportFailures?: boolean }) => {
        if (throwsLeft > 0) {
            throwsLeft--;
            throw new Error('Git API timeout');
        }
        return trigger.execute(message, executeOpts);
    });
    const metrics: WebhookReconcilerMetrics & { counts: Record<string, number> } = {
        counts: {},
        started(count) {
            this.counts.started = (this.counts.started ?? 0) + count;
        },
        handed(outcome) {
            this.counts[`handed:${outcome}`] = (this.counts[`handed:${outcome}`] ?? 0) + 1;
        },
        skipped(reason, count = 1) {
            this.counts[`skipped:${reason}`] = (this.counts[`skipped:${reason}`] ?? 0) + count;
        },
    };
    const automatic = {
        listAutomaticAcrossOrganizations: async () =>
            settings.filter((s) => s.mode === 'rules').map((s) => ({ organizationId: ORG, repositoryId: s.repositoryId, updatedAt: opts.settingsUpdatedAt ?? new Date(NOW.getTime() - 10 * 24 * HOUR).toISOString() })),
    };
    const stops =
        opts.stopped === undefined
            ? undefined
            : {
                  isStopped: async () => {
                      if (opts.stopped instanceof Error) throw opts.stopped;
                      return opts.stopped as boolean;
                  },
              };
    const platforms = { getTypeIntegration: async () => platform };
    const reconciler = new RuntimeWebhookReconciler(
        { ...on, ...opts.config },
        automatic,
        environments,
        members,
        setups,
        db.projection,
        git,
        platforms,
        db.ledger,
        { execute },
        stops,
        metrics,
    );
    return { reconciler, git, execute, metrics, environments, setups, members, platforms, trigger };
}

const requested = (db: Awaited<ReturnType<typeof shared>>) =>
    db.outbox.rows.filter((r) => r.payload.event_name === 'runtime.run.requested').map((r) => RuntimeRunRequestedSchema.parse((({ workflowType: _t, ...rest }) => rest)(r.payload.payload)));

describe('Lost-webhook reconciler', () => {
    it('an open PR whose head a lost webhook never ran gets one Run, the one the webhook would have started', async () => {
        const db = await shared();
        const { reconciler, metrics } = replica(db);
        const summary = await reconciler.tick(NOW);
        const runs = requested(db);
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ trigger: 'pull_request', pullRequest: { number: 7, headSha: SHA }, repository: { id: REPO } });
        expect(summary).toMatchObject({ handed: 1, started: 1 });
        expect(metrics.counts).toMatchObject({ started: 1, 'handed:enqueued': 1 });

        // The same Run as the webhook's trigger: a webhook that arrives late enqueues this very runId.
        const late = await shared();
        await replica(late).reconciler.tick(NOW);
        expect(requested(late)[0].runId).toBe(runs[0].runId);
    });

    it('a second tick, and a tick after a restart, start nothing for that head', async () => {
        const db = await shared();
        const first = replica(db);
        await first.reconciler.tick(NOW);
        await first.reconciler.tick(new Date(NOW.getTime() + 10 * 60_000));
        // A restarted worker: a new process, the same database.
        const restarted = replica(db);
        const summary = await restarted.reconciler.tick(new Date(NOW.getTime() + 20 * 60_000));
        expect(requested(db)).toHaveLength(1);
        expect(first.execute).toHaveBeenCalledTimes(1);
        expect(restarted.execute).not.toHaveBeenCalled();
        expect(summary.skipped).toMatchObject({ already_reconciled: 1 });
    });

    it('two replicas ticking at once start one Run', async () => {
        const db = await shared();
        const a = replica(db);
        const b = replica(db);
        const summaries = await Promise.all([a.reconciler.tick(NOW), b.reconciler.tick(NOW), a.reconciler.tick(NOW)]);
        expect(requested(db)).toHaveLength(1);
        expect(a.execute.mock.calls.length + b.execute.mock.calls.length).toBe(1);
        expect(summaries.reduce((n, s) => n + s.started, 0)).toBe(1);
    });

    it.each(['superseded', 'cancelled', 'regression', 'errored'] as const)('a head that already has a Run in state %s is never run again', async (state) => {
        // superseded: a newer push replaced it; cancelled: the PR closed or the Runtime was stopped.
        const db = await shared({ runs: [run({ state, headSha: SHA })] });
        const { reconciler, execute } = replica(db);
        const summary = await reconciler.tick(NOW);
        expect(requested(db)).toHaveLength(0);
        expect(execute).not.toHaveBeenCalled();
        expect(summary.skipped).toMatchObject({ already_ran: 1 });
    });

    it("a Run on another head of the PR does not count: the current head still gets its Run", async () => {
        const db = await shared({ runs: [run({ state: 'superseded', headSha: SHA })] });
        const { reconciler } = replica(db, { prs: [openPr({ headSha: NEW_SHA })] });
        await reconciler.tick(NOW);
        expect(requested(db).map((r) => r.pullRequest.headSha)).toEqual([NEW_SHA]);
    });

    it('a PR not updated within the window starts nothing: its head is older than the window', async () => {
        const db = await shared();
        const old = new Date(NOW.getTime() - 25 * HOUR).toISOString();
        const { reconciler, execute } = replica(db, { prs: [openPr({ updatedAt: old })] });
        expect((await reconciler.tick(NOW)).skipped).toMatchObject({ outside_window: 1 });
        expect(execute).not.toHaveBeenCalled();
        // A wider window takes it.
        const wide = replica(db, { prs: [openPr({ updatedAt: old })], config: { windowMs: 48 * HOUR } });
        await wide.reconciler.tick(NOW);
        expect(requested(db)).toHaveLength(1);
    });

    it('a PR last updated before the mode was saved, or before the setup became active, starts nothing: no webhook would have run it', async () => {
        const db = await shared();
        const beforeSettings = replica(db, { settingsUpdatedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString() });
        expect((await beforeSettings.reconciler.tick(NOW)).skipped).toMatchObject({ outside_window: 1 });
        const beforeSetup = replica(db, { setup: { state: 'active', finishedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString() } });
        expect((await beforeSetup.reconciler.tick(NOW)).skipped).toMatchObject({ outside_window: 1 });
        expect(requested(db)).toHaveLength(0);
    });

    it('a PR updated within the grace is left to its webhook, which may still be on its way', async () => {
        const db = await shared();
        const { reconciler, execute } = replica(db, { prs: [openPr({ updatedAt: new Date(NOW.getTime() - 60_000).toISOString() })] });
        expect((await reconciler.tick(NOW)).skipped).toMatchObject({ too_recent: 1 });
        expect(execute).not.toHaveBeenCalled();
    });

    it('a draft is left alone without a ledger row, so it is handed once it is ready', async () => {
        const db = await shared();
        expect((await replica(db, { prs: [openPr({ draft: true })] }).reconciler.tick(NOW)).skipped).toMatchObject({ draft: 1 });
        expect(db.ledger.rows.size).toBe(0);
        await replica(db).reconciler.tick(NOW);
        expect(requested(db)).toHaveLength(1);
    });

    it("the trigger's own rules still decide: a fork per its policy, a rule that does not match, on request", async () => {
        const skipped = await shared();
        await replica(skipped, { head: { fork: true }, forkPolicy: 'skip' }).reconciler.tick(NOW);
        expect(requested(skipped)).toHaveLength(0);
        // The default policy: the same Run a webhook would enqueue, held for a maintainer's approval.
        const held = await shared();
        await replica(held, { head: { fork: true } }).reconciler.tick(NOW);
        expect(requested(held)).toEqual([expect.objectContaining({ pullRequest: expect.objectContaining({ fork: true }) })]);
        // On request only: the reconciler never reads the repository (only mode `rules` is automatic).
        const onRequest = await shared();
        const r = replica(onRequest, { settings: [rules({ mode: 'on_request' })] });
        expect(await r.reconciler.tick(NOW)).toMatchObject({ repositories: 0, handed: 0 });
        expect(r.git.listOpenPullRequests).not.toHaveBeenCalled();
        const noMatch = await shared();
        const m = replica(noMatch, { settings: [rules({ rules: [{ conditions: [{ field: 'changed_paths', matches: 'docs/**' }] }] })] });
        expect(await m.reconciler.tick(NOW)).toMatchObject({ handed: 1, started: 0 });
        expect(m.metrics.counts).toMatchObject({ 'handed:skipped:rule_not_matched': 1 });
        // Decided once: the next tick does not ask the Git API again.
        await m.reconciler.tick(new Date(NOW.getTime() + 10 * 60_000));
        expect(m.execute).toHaveBeenCalledTimes(1);
    });

    it('an environment whose setup is not active, a stopped org, and an org whose stop cannot be read are not read', async () => {
        for (const [opts, reason] of [
            [{ setup: { state: 'setting_up' } }, undefined],
            [{ stopped: true }, 'org_stopped'],
            [{ stopped: new Error('runtime db down') }, 'stop_unknown'],
        ] as const) {
            const db = await shared();
            const r = replica(db, opts);
            const summary = await r.reconciler.tick(NOW);
            expect(r.git.listOpenPullRequests).not.toHaveBeenCalled();
            expect(requested(db)).toHaveLength(0);
            if (reason) expect(summary.skipped).toMatchObject({ [reason]: 1 });
        }
    });

    it('logs a repository it skips because a read failed, and counts it apart from one with nothing to do', async () => {
        const down = () => Promise.reject(new Error('product db down'));
        for (const [fail, reason] of [
            [(r: ReturnType<typeof replica>) => jest.spyOn(r.environments, 'findByRepository').mockImplementation(down), 'environment_unreadable'],
            [(r: ReturnType<typeof replica>) => jest.spyOn(r.setups, 'get').mockImplementation(down), 'setup_unreadable'],
            [(r: ReturnType<typeof replica>) => jest.spyOn(r.members, 'list').mockImplementation(down), 'members_unreadable'],
            [(r: ReturnType<typeof replica>) => jest.spyOn(r.platforms, 'getTypeIntegration').mockImplementation(down), 'platform_unreadable'],
        ] as const) {
            const db = await shared();
            const r = replica(db);
            fail(r);
            const warn = jest.spyOn((r.reconciler as any).logger, 'warn').mockImplementation(() => undefined);
            const summary = await r.reconciler.tick(NOW);
            expect(r.git.listOpenPullRequests).not.toHaveBeenCalled();
            expect(summary.skipped).toEqual({ [reason]: 1 });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(JSON.stringify(warn.mock.calls[0][0])).toContain(ORG);
            expect(JSON.stringify(warn.mock.calls[0][0])).toContain(reason === 'platform_unreadable' ? TEAM : REPO);
        }
    });

    it('says so when the failure of a trigger call could not be recorded in the ledger', async () => {
        const db = await shared();
        const r = replica(db, { triggerThrows: 1 });
        jest.spyOn(db.ledger, 'fail').mockRejectedValue(new Error('ledger down'));
        const warn = jest.spyOn((r.reconciler as any).logger, 'warn').mockImplementation(() => undefined);
        await r.reconciler.tick(NOW);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ failureRecorded: false }) }));
    });

    it('only platforms whose webhooks write Runtime events are reconciled', async () => {
        const db = await shared();
        const r = replica(db, { platform: PlatformType.GITLAB });
        expect((await r.reconciler.tick(NOW)).skipped).toMatchObject({ platform_not_reconciled: 1 });
        expect(r.git.listOpenPullRequests).not.toHaveBeenCalled();
    });

    it('hands at most the per-org cap per tick; the rest waits for the next ticks', async () => {
        const prs = [1, 2, 3, 4, 5].map((n) => openPr({ number: n, headSha: String(n).repeat(40) }));
        const db = await shared();
        const r = replica(db, { prs, config: { perOrgPerTick: 2 } });
        const first = await r.reconciler.tick(NOW);
        expect(first).toMatchObject({ handed: 2 });
        expect(first.skipped).toMatchObject({ org_cap: 1 });
        await r.reconciler.tick(new Date(NOW.getTime() + 10 * 60_000));
        await r.reconciler.tick(new Date(NOW.getTime() + 20 * 60_000));
        expect(r.execute).toHaveBeenCalledTimes(5);
    });

    it('lists at most the repository cap per tick, and hands nothing past the deadline', async () => {
        const db = await shared();
        const two = [rules(), rules({ repositoryId: 'repo-other' })];
        const uncapped = replica(await shared(), { settings: two });
        await uncapped.reconciler.tick(NOW);
        expect(uncapped.git.listOpenPullRequests).toHaveBeenCalledTimes(2);
        const capped = replica(db, { config: { repositoriesPerTick: 1 }, settings: two });
        expect((await capped.reconciler.tick(NOW)).skipped).toMatchObject({ repository_cap: 1 });
        expect(capped.git.listOpenPullRequests).toHaveBeenCalledTimes(1);
        const late = replica(db);
        expect((await late.reconciler.tick(NOW, Date.now() - 1)).skipped).toMatchObject({ deadline: 1 });
        expect(late.execute).not.toHaveBeenCalled();
    });

    it('a trigger that throws leaves the head to a later tick, up to the attempt limit, and never starts two Runs', async () => {
        const db = await shared();
        const r = replica(db, { triggerThrows: 1 });
        expect(await r.reconciler.tick(NOW)).toMatchObject({ handed: 1, started: 0 });
        expect(r.metrics.counts).toMatchObject({ 'handed:failed': 1 });
        await r.reconciler.tick(new Date(NOW.getTime() + 10 * 60_000));
        expect(requested(db)).toHaveLength(1);

        const broken = await shared();
        const b = replica(broken, { triggerThrows: 100 });
        for (let i = 0; i < RECONCILE_MAX_ATTEMPTS + 2; i++) await b.reconciler.tick(new Date(NOW.getTime() + i * 10 * 60_000));
        expect(b.execute).toHaveBeenCalledTimes(RECONCILE_MAX_ATTEMPTS);
    });

    it('a setup the trigger cannot read leaves the head unsettled, logged once, and a later tick starts its Run', async () => {
        const db = await shared();
        const r = replica(db);
        const read = r.setups.get.bind(r.setups);
        // The reconciler's own read answers; the trigger's, right after, fails.
        jest.spyOn(r.setups, 'get')
            .mockImplementationOnce(read)
            .mockImplementationOnce(async () => {
                throw new Error('connection terminated unexpectedly');
            });
        const reconcilerWarn = jest.spyOn((r.reconciler as any).logger, 'warn').mockImplementation(() => undefined);
        const triggerWarn = jest.spyOn((r.trigger as any).logger, 'warn').mockImplementation(() => undefined);
        expect(await r.reconciler.tick(NOW)).toMatchObject({ handed: 1, started: 0 });
        expect(r.metrics.counts).toMatchObject({ 'handed:failed': 1 });
        expect(r.metrics.counts['handed:skipped']).toBeUndefined();
        expect(reconcilerWarn.mock.calls.length + triggerWarn.mock.calls.length).toBe(1);

        await r.reconciler.tick(new Date(NOW.getTime() + 10 * 60_000));
        expect(requested(db)).toHaveLength(1);
    });

    it('a head whose environment is genuinely not ready is settled and not handed again', async () => {
        const db = await shared();
        const r = replica(db);
        const read = r.setups.get.bind(r.setups);
        // Active when the reconciler looked, setting up again when the trigger read it.
        jest.spyOn(r.setups, 'get')
            .mockImplementationOnce(read)
            .mockImplementationOnce(async () => ({ state: 'setting_up', organizationId: ORG }) as any);
        await r.reconciler.tick(NOW);
        await r.reconciler.tick(new Date(NOW.getTime() + 10 * 60_000));
        expect(r.execute).toHaveBeenCalledTimes(1);
        expect(requested(db)).toHaveLength(0);
    });

    it('is off unless enabled: a tick reads nothing', async () => {
        const db = await shared();
        const r = replica(db, { config: { enabled: false } });
        expect(await r.reconciler.tick(NOW)).toMatchObject({ enabled: false, organizations: 0 });
        expect(r.git.listOpenPullRequests).not.toHaveBeenCalled();
        expect(loadWebhookReconcilerConfig({}).enabled).toBe(false);
    });

    it('its settings default to conservative values and refuse nonsense', () => {
        expect(loadWebhookReconcilerConfig({})).toEqual({ enabled: false, windowMs: 24 * HOUR, graceMs: 10 * 60_000, perOrgPerTick: 2, perTick: 10, repositoriesPerTick: 100 });
        const set = loadWebhookReconcilerConfig({
            RUNTIME_WEBHOOK_RECONCILER_ENABLED: 'true',
            RUNTIME_WEBHOOK_RECONCILER_WINDOW_MINUTES: '999999',
            RUNTIME_WEBHOOK_RECONCILER_GRACE_MINUTES: '-3',
            RUNTIME_WEBHOOK_RECONCILER_PER_ORG_PER_TICK: '1.5',
        });
        expect(set).toMatchObject({ enabled: true, windowMs: 7 * 24 * HOUR, graceMs: 10 * 60_000, perOrgPerTick: 2 });
    });
});
