import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { InMemoryRunTargetStore } from '@libs/runtime-publish/domain/run-target';
import { runtimeTriggerOutboxMessage, RuntimeRunCancelRequestedSchema, RuntimeRunRequestedSchema, type RuntimePullRequestObserved } from '@libs/runtime/run';

import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import { RuntimeRunEnqueuer } from '../application/runtime-run-enqueuer.service';
import { RuntimePullRequestTriggerUseCase } from '../application/use-cases/pull-request-trigger.use-case';
import type { PullRequestHead, RuntimeGitPort, RuntimeRepositorySettingsRecord } from '../domain/ports';
import { BASE_SHA, clock, config, FakeOutbox, NOW, ORG, REPO, run, SECRET, SHA, storeWith, TEAM } from './fixtures';

const NEW_SHA = 'c'.repeat(40);

const event = (patch: Partial<RuntimePullRequestObserved> = {}): RuntimePullRequestObserved => ({
    organizationId: ORG,
    teamId: TEAM,
    repository: { id: REPO, name: 'acme/shop' },
    prNumber: 7,
    event: 'opened',
    headSha: SHA,
    labels: [],
    author: { login: 'dev', isBot: false },
    observedAt: NOW.toISOString(),
    ...patch,
});

const rules = (patch: Partial<RuntimeRepositorySettingsRecord> = {}): RuntimeRepositorySettingsRecord => ({
    repositoryId: REPO,
    pilot: true,
    whoCanAsk: 'writers',
    mode: 'rules',
    rules: [{ conditions: [{ field: 'changed_paths', matches: 'src/orders/**' }] }],
    runOnAgentPullRequests: false,
    runOnNewPushes: false,
    ...patch,
});

async function setup(opts: {
    settings?: RuntimeRepositorySettingsRecord[];
    runs?: ReturnType<typeof run>[];
    head?: PullRequestHead | null;
    setupState?: 'active' | 'setting_up' | 'blocked' | null;
    canWrite?: boolean | undefined;
    member?: boolean | undefined;
    paths?: string[];
    truncated?: boolean;
    forkPullRequests?: string | null;
} = {}) {
    const head = opts.head === undefined ? { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'open' as const } : opts.head;
    const git = {
        getPullRequestHead: async () => head,
        getPullRequestDiff: async () => ({
            files: (opts.paths ?? ['src/orders/orders.controller.ts']).map((path) => ({ path, patch: '@@ -1 +1 @@\n-a\n+b' })),
            truncated: opts.truncated ?? false,
        }),
        userCanWrite: async () => opts.canWrite,
        isOrganizationMember: async () => opts.member,
    } as unknown as RuntimeGitPort;
    const outbox = new FakeOutbox();
    const targets = new InMemoryRunTargetStore();
    const enqueuer = new RuntimeRunEnqueuer(targets, outbox as any, { getTypeIntegration: async () => PlatformType.GITHUB });
    const env = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', state: 'active', createdAt: '', updatedAt: '', ...(opts.forkPullRequests !== undefined ? { forkPullRequests: opts.forkPullRequests } : {}) };
    const builder = new RuntimeRunRequestBuilder(
        git,
        { issue: async () => 'repo-token' },
        { get: async () => ({ environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, imageId: 'img-1', expose: [] }) },
        config({ runTokenSecret: SECRET }),
        clock,
    );
    const setupState = opts.setupState === undefined ? 'active' : opts.setupState;
    const pool = { onPullRequest: jest.fn(async (_env: unknown) => undefined) };
    const useCase = new RuntimePullRequestTriggerUseCase(
        { listRepositories: async () => opts.settings ?? [rules()] },
        { findByRepository: async (org: string, repo: string) => (org === ORG && repo === REPO ? (env as any) : null) },
        await storeWith(...(opts.runs ?? [])),
        git,
        builder,
        enqueuer,
        { get: async (org: string) => (setupState && org === ORG ? ({ state: setupState, organizationId: ORG } as any) : null) },
        pool,
    );
    const requested = () => outbox.rows.filter((r) => r.payload.event_name === 'runtime.run.requested').map((r) => RuntimeRunRequestedSchema.parse(stripType(r.payload.payload)));
    const cancels = () => outbox.rows.filter((r) => r.payload.event_name === 'runtime.run.cancel_requested').map((r) => RuntimeRunCancelRequestedSchema.parse(stripType(r.payload.payload)));
    return { useCase, outbox, targets, requested, cancels, pool };
}

const stripType = ({ workflowType: _t, ...rest }: any) => rest;

describe('Runtime PR trigger (PR 2)', () => {
    it('a PR that matches a rule enqueues a Run with its publish target, from the outbox envelope', async () => {
        const { useCase, targets, requested } = await setup();
        const outcome = await useCase.execute(runtimeTriggerOutboxMessage(event(), 'm-1').payload);
        expect(outcome).toMatchObject({ action: 'enqueued', trigger: 'pull_request' });
        const [req] = requested();
        expect(req).toMatchObject({ trigger: 'pull_request', pullRequest: { number: 7, headSha: SHA, fork: false }, repository: { id: REPO } });
        expect(await targets.get(req.runId)).toMatchObject({ pullRequestNumber: 7, platform: PlatformType.GITHUB, headSha: SHA });
    });

    it("a PR event on a ready environment restarts the pool's warm-up; a failing pool never stops the Run", async () => {
        const ready = await setup();
        await ready.useCase.execute(event());
        expect(ready.pool.onPullRequest).toHaveBeenCalledWith(expect.objectContaining({ environmentId: 'env-1' }));
        const notReady = await setup({ setupState: 'setting_up' });
        await notReady.useCase.execute(event());
        expect(notReady.pool.onPullRequest).not.toHaveBeenCalled();
        const broken = await setup();
        broken.pool.onPullRequest.mockRejectedValueOnce(new Error('db down'));
        expect(await broken.useCase.execute(event())).toMatchObject({ action: 'enqueued' });
    });

    it('does not run when the mode is off, on request only, or no rule matches', async () => {
        expect(await (await setup({ settings: [] })).useCase.execute(event())).toEqual({ action: 'skipped', reason: 'off' });
        expect(await (await setup({ settings: [rules({ mode: 'off' })] })).useCase.execute(event())).toEqual({ action: 'skipped', reason: 'off' });
        expect(await (await setup({ settings: [rules({ mode: 'on_request' })] })).useCase.execute(event())).toEqual({ action: 'skipped', reason: 'on_request_only' });
        expect(await (await setup({ paths: ['docs/readme.md'] })).useCase.execute(event())).toEqual({ action: 'skipped', reason: 'rule_not_matched' });
    });

    it('needs an environment whose setup is ready, an open PR and no draft', async () => {
        expect(await (await setup({ setupState: 'setting_up' })).useCase.execute(event())).toEqual({ action: 'skipped', reason: 'environment_not_ready' });
        expect(await (await setup({ settings: [rules({ repositoryId: 'other' })] })).useCase.execute(event({ repository: { id: 'other', name: 'x/y' } }))).toEqual({
            action: 'skipped',
            reason: 'no_environment',
        });
        expect(await (await setup({ head: { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'merged' } })).useCase.execute(event())).toEqual({
            action: 'skipped',
            reason: 'pr_not_open',
        });
        // Draft comes from the Git API: the event's flag decides nothing (ADR-057).
        expect(await (await setup({ head: { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'open', draft: true } })).useCase.execute(event())).toEqual({
            action: 'skipped',
            reason: 'draft',
        });
        expect(await (await setup()).useCase.execute(event({ draft: true }))).toMatchObject({ action: 'enqueued' });
    });

    it('labels come from the Git API, not from the event', async () => {
        const settings = [rules({ rules: [{ conditions: [{ field: 'label', includes: 'runtime' }] }] })];
        expect(await (await setup({ settings })).useCase.execute(event({ labels: ['runtime'] }))).toEqual({ action: 'skipped', reason: 'rule_not_matched' });
        const labelled = await setup({ settings, head: { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'open', labels: ['Runtime'] } });
        expect(await labelled.useCase.execute(event())).toMatchObject({ action: 'enqueued' });
    });

    it('a late synchronize of an older head never cancels the Run of the real head (out-of-order webhooks)', async () => {
        // The Git API says the head is SHA, a Run is live on it; the stale event names OLD.
        const s = await setup({ runs: [run({ state: 'testing', headSha: SHA })] });
        const outcome = await s.useCase.execute(event({ event: 'synchronize', headSha: 'd'.repeat(40) }));
        expect(s.cancels()).toEqual([]);
        expect(outcome).toEqual({ action: 'skipped', reason: 'already_ran_on_head' });
    });

    it('a late closed on a PR the Git API says is open cancels nothing', async () => {
        const s = await setup({ runs: [run({ state: 'booting' })] });
        expect(await s.useCase.execute(event({ event: 'closed' }))).toEqual({ action: 'skipped', reason: 'pr_still_open' });
        expect(s.cancels()).toEqual([]);
    });

    it('a redelivered event enqueues the same Run (derived runId)', async () => {
        const a = await setup();
        const b = await setup();
        await a.useCase.execute(event());
        await b.useCase.execute(event());
        expect(a.requested()[0].runId).toBe(b.requested()[0].runId);
    });

    it('a truncated diff carries the marker entry, so the Run is partly tested at best', async () => {
        const s = await setup({ truncated: true });
        await s.useCase.execute(event());
        const [req] = s.requested();
        expect(req.diffTruncated).toBe(true);
        expect(req.diff[req.diff.length - 1].path).toBe('.kodus-runtime/diff-truncated');
    });

    it('drops a malformed event instead of retrying it', async () => {
        expect(await (await setup()).useCase.execute({ organizationId: ORG })).toEqual({ action: 'skipped', reason: 'invalid_event' });
    });

    it('runs once per head: a duplicate webhook or a Run already finished on that head starts nothing', async () => {
        const live = await setup({ runs: [run({ state: 'testing', headSha: SHA })] });
        expect(await live.useCase.execute(event({ event: 'reopened' }))).toEqual({ action: 'skipped', reason: 'already_ran_on_head' });
        const done = await setup({ runs: [run({ state: 'no_regressions', headSha: SHA })] });
        expect(await done.useCase.execute(event({ event: 'ready_for_review' }))).toEqual({ action: 'skipped', reason: 'already_ran_on_head' });
        expect(done.requested()).toHaveLength(0);
    });

    it('a new push cancels the live Run of the old head, and runs again only when the repo asks for it', async () => {
        const off = await setup({ runs: [run({ state: 'testing', headSha: SHA })], head: { headSha: NEW_SHA, baseSha: BASE_SHA, fork: false, state: 'open' } });
        expect(await off.useCase.execute(event({ event: 'synchronize', headSha: NEW_SHA }))).toEqual({ action: 'skipped', reason: 'new_pushes_off' });
        expect(off.cancels()).toEqual([{ organizationId: ORG, repositoryId: REPO, prNumber: 7, reason: 'superseded', headSha: NEW_SHA }]);

        const on = await setup({
            settings: [rules({ runOnNewPushes: true })],
            runs: [run({ state: 'no_regressions', headSha: SHA })],
            head: { headSha: NEW_SHA, baseSha: BASE_SHA, fork: false, state: 'open' },
        });
        expect(await on.useCase.execute(event({ event: 'synchronize', headSha: NEW_SHA }))).toMatchObject({ action: 'enqueued' });
        expect(on.requested()[0].pullRequest.headSha).toBe(NEW_SHA);
        expect(on.cancels()).toHaveLength(0);
    });

    it('a closed PR cancels its live Runs, even with the Runtime off', async () => {
        const closed = { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'closed' as const };
        const { useCase, cancels } = await setup({ settings: [], runs: [run({ state: 'booting' })], head: closed });
        expect(await useCase.execute(event({ event: 'closed' }))).toEqual({ action: 'cancelled', reason: 'pr_closed' });
        expect(cancels()).toEqual([{ organizationId: ORG, repositoryId: REPO, prNumber: 7, reason: 'pr_closed' }]);
        expect(await (await setup({ runs: [], head: closed })).useCase.execute(event({ event: 'closed' }))).toEqual({ action: 'skipped', reason: 'nothing_live' });
    });

    it('agent and bot PRs run only when the repo turns that on', async () => {
        // The author is the Git API's; the event saying "bot" or "human" decides nothing.
        const botHead = { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'open' as const, authorLogin: 'devin-ai-integration[bot]' };
        expect(await (await setup({ head: botHead })).useCase.execute(event())).toEqual({ action: 'skipped', reason: 'bot_author' });
        expect(await (await setup({ head: botHead, settings: [rules({ runOnAgentPullRequests: true })] })).useCase.execute(event())).toMatchObject({ action: 'enqueued' });
        expect(await (await setup()).useCase.execute(event({ author: { login: 'devin-ai-integration[bot]', isBot: true } }))).toMatchObject({ action: 'enqueued' });
    });

    it('@kody runtime runs on request whatever the rules, and only for someone allowed to ask', async () => {
        const comment = event({ event: 'comment', commenter: { id: '42', login: 'maria' } });
        const ok = await setup({ settings: [rules({ mode: 'on_request' })], canWrite: true });
        expect(await ok.useCase.execute(comment)).toMatchObject({ action: 'enqueued', trigger: 'comment' });
        expect(ok.requested()[0].trigger).toBe('comment');

        expect(await (await setup({ canWrite: false })).useCase.execute(comment)).toEqual({ action: 'skipped', reason: 'commenter_not_allowed' });
        // The platform cannot say: denied.
        expect(await (await setup({ canWrite: undefined })).useCase.execute(comment)).toEqual({ action: 'skipped', reason: 'commenter_not_allowed' });
        // Anyone in the org is checked as membership on the Git API; unknown or no denies.
        expect(await (await setup({ settings: [rules({ whoCanAsk: 'anyone_in_org' })], canWrite: false, member: true })).useCase.execute(comment)).toMatchObject({ action: 'enqueued' });
        expect(await (await setup({ settings: [rules({ whoCanAsk: 'anyone_in_org' })], member: false })).useCase.execute(comment)).toEqual({ action: 'skipped', reason: 'commenter_not_allowed' });
        expect(await (await setup({ settings: [rules({ whoCanAsk: 'anyone_in_org' })], member: undefined })).useCase.execute(comment)).toEqual({ action: 'skipped', reason: 'commenter_not_allowed' });
        // Asking again on a head that already ran is allowed; a live Run on it is not doubled.
        const again = await setup({ canWrite: true, runs: [run({ state: 'regression', headSha: SHA })] });
        expect(await again.useCase.execute(comment)).toMatchObject({ action: 'enqueued' });
        const busy = await setup({ canWrite: true, runs: [run({ state: 'testing', headSha: SHA })] });
        expect(await busy.useCase.execute(comment)).toEqual({ action: 'skipped', reason: 'already_running' });
    });

    describe('a fork PR follows the environment policy (ADR-030)', () => {
        const forkHead = { headSha: SHA, baseSha: BASE_SHA, fork: true, state: 'open' as const };
        const comment = event({ event: 'comment', commenter: { id: '1', login: 'm' } });

        it('skip: no Run, on a PR event or a comment, and no warm-up', async () => {
            const { useCase, requested, pool } = await setup({ head: forkHead, canWrite: true, forkPullRequests: 'skip' });
            expect(await useCase.execute(event())).toEqual({ action: 'skipped', reason: 'fork_pull_requests_skipped' });
            expect(await useCase.execute(comment)).toEqual({ action: 'skipped', reason: 'fork_pull_requests_skipped' });
            expect(requested()).toHaveLength(0);
            expect(pool.onPullRequest).not.toHaveBeenCalled();
        });

        it.each([undefined, null, 'require_approval', 'bogus'])('%s: the Run waits for a maintainer (no opt-out flag), on the fork budget', async (policy) => {
            const { useCase, requested, pool } = await setup({ head: forkHead, forkPullRequests: policy as string | null | undefined });
            expect(await useCase.execute(event())).toMatchObject({ action: 'enqueued' });
            const [req] = requested();
            expect(req.pullRequest.fork).toBe(true);
            expect(req.pullRequest).not.toHaveProperty('forkApprovalRequired');
            expect(req.budget!.maxTokens).toBe(Math.floor(config().llmBudget.perRun / 4));
            expect(pool.onPullRequest).not.toHaveBeenCalled();
        });

        it('run: the Run starts without an approval, still on the fork budget and without warm-up', async () => {
            const { useCase, requested, pool } = await setup({ head: forkHead, forkPullRequests: 'run' });
            expect(await useCase.execute(event())).toMatchObject({ action: 'enqueued' });
            const [req] = requested();
            expect(req.pullRequest).toMatchObject({ fork: true, forkApprovalRequired: false });
            expect(req.budget!.maxTokens).toBe(Math.floor(config().llmBudget.perRun / 4));
            expect(pool.onPullRequest).not.toHaveBeenCalled();
        });

        it('a PR from the same repository ignores the policy: full budget, warm-up, no fork flags', async () => {
            const { useCase, requested, pool } = await setup({ forkPullRequests: 'skip' });
            expect(await useCase.execute(event())).toMatchObject({ action: 'enqueued' });
            const [req] = requested();
            expect(req.pullRequest.fork).toBe(false);
            expect(req.pullRequest).not.toHaveProperty('forkApprovalRequired');
            expect(req.budget!.maxTokens).toBe(config().llmBudget.perRun);
            expect(pool.onPullRequest).toHaveBeenCalledTimes(1);
        });
    });
});
