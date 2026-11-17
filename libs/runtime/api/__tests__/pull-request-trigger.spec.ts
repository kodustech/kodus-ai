// The real download-token issuer pulls in the GitHub service, which reads the (untracked) EE environment.
jest.mock('../../../ee/configs/environment/environment', () => ({ environment: {} }), { virtual: true });

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { RepositoryDownloadTokenError } from '@libs/platform/infrastructure/adapters/services/github/repository-download-token';
import { SkippedTriggerReplyPublisher } from '@libs/runtime-publish/application/skipped-trigger-reply';
import type { CodeManagementPort } from '@libs/runtime-publish/domain/runtime-publish.ports';
import { runtimeTriggerOutboxMessage, RuntimeRunCancelRequestedSchema, RuntimeRunRequestedSchema, type RuntimePullRequestObserved } from '@libs/runtime/run';

import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import { RuntimeRunEnqueuer } from '../application/runtime-run-enqueuer.service';
import { RuntimePullRequestTriggerUseCase } from '../application/use-cases/pull-request-trigger.use-case';
import { ASKED_RUNS_REACHED_DETAIL } from '../application/asked-runs';
import { COMMENT_RUNS_PER_PULL_REQUEST_PER_DAY } from '../domain/trigger-rules';
import type { PullRequestHead, RuntimeGitPort, RuntimeRepoTokenIssuer, RuntimeRepositorySettingsRecord } from '../domain/ports';
import { CodeManagementRepoTokenIssuer } from '../infrastructure/repo-token-issuer.adapter';
import { BASE_SHA, clock, config, FakeOutbox, NOW, ORG, REPO, run, SECRET, SHA, storeWith, TEAM } from './fixtures';
import { InMemoryPublicationStore, InMemoryRunTargetStore } from '@libs/runtime-publish/testing';

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
    /** The PR's comments, shared across setups to replay a redelivery on the same platform and store. */
    platform?: ReturnType<typeof fakePlatform>;
    publications?: InMemoryPublicationStore;
    /** What the integration's own credential can do on the repository, as the provider answers it. */
    readAccess?: 'ok' | 'denied' | 'unknown';
    issuer?: RuntimeRepoTokenIssuer;
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
        repositoryReadAccess: async () => opts.readAccess ?? 'ok',
    } as unknown as RuntimeGitPort;
    const outbox = new FakeOutbox();
    const targets = new InMemoryRunTargetStore();
    const platform = opts.platform ?? fakePlatform();
    const publications = opts.publications ?? new InMemoryPublicationStore();
    const enqueuer = new RuntimeRunEnqueuer(targets, outbox as any, { getTypeIntegration: async () => PlatformType.GITHUB });
    const env = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', state: 'active', createdAt: '', updatedAt: '', ...(opts.forkPullRequests !== undefined ? { forkPullRequests: opts.forkPullRequests } : {}) };
    const builder = new RuntimeRunRequestBuilder(
        git,
        opts.issuer ?? { issue: async () => 'repo-token' },
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
        undefined,
        new SkippedTriggerReplyPublisher(
            publications,
            { resolve: async (_orgTeam, repositoryId) => (repositoryId === REPO ? { id: REPO, name: 'shop', owner: 'acme', fullName: 'acme/shop' } : null) },
            platform.port,
            { ownAuthor: async () => ({ userIds: [KODY_ACCOUNT] }) },
        ),
    );
    const requested = () => outbox.rows.filter((r) => r.payload.event_name === 'runtime.run.requested').map((r) => RuntimeRunRequestedSchema.parse(stripType(r.payload.payload)));
    const cancels = () => outbox.rows.filter((r) => r.payload.event_name === 'runtime.run.cancel_requested').map((r) => RuntimeRunCancelRequestedSchema.parse(stripType(r.payload.payload)));
    return { useCase, outbox, targets, requested, cancels, pool, platform, publications };
}

/** The account the integration's token belongs to: who Kody posts as. */
const KODY_ACCOUNT = 'kody-bot';

/** The PR's comments as the Git platform keeps them; `loseNextAnswer` posts the comment, then fails the call. */
function fakePlatform() {
    const comments: Array<{ id: number; body: string; user: { id: string } }> = [];
    const state = { loseNextAnswer: false, refuseComments: false };
    const port: CodeManagementPort = {
        getTypeIntegration: async () => PlatformType.GITHUB,
        createIssueComment: async ({ body }) => {
            if (state.refuseComments) throw new Error('Not Found');
            const comment = { id: comments.length + 1, body, user: { id: KODY_ACCOUNT } };
            comments.push(comment);
            if (state.loseNextAnswer) {
                state.loseNextAnswer = false;
                throw new Error('socket hang up');
            }
            return comment;
        },
        getAllCommentsInPullRequest: async () => [...comments],
        createResponseToComment: async () => null,
        updateIssueComment: async () => null,
    };
    return { comments, state, port };
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

    it('fails the event, enqueuing nothing and answering nothing, when the setup store cannot be read', async () => {
        const s = await setup({});
        jest.spyOn((s.useCase as any).setups, 'get').mockImplementation(async () => {
            throw new Error('connection terminated unexpectedly');
        });
        const warn = jest.spyOn((s.useCase as any).logger, 'warn').mockImplementation(() => undefined);
        await expect(s.useCase.execute(event())).rejects.toThrow();
        await expect(s.useCase.execute(event({ event: 'comment', commenter: { id: '42', login: 'maria' } }))).rejects.toThrow();
        expect(s.outbox.rows).toHaveLength(0);
        expect(s.platform.comments).toHaveLength(0);
        // The broker's handler logs only the message: the trigger logs each failure once, with its ids.
        expect(warn).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(warn.mock.calls[0][0])).toContain('env-1');
    });

    it('needs an environment whose setup is ready, an open PR and no draft', async () => {
        expect(await (await setup({ setupState: 'setting_up' })).useCase.execute(event())).toEqual({ action: 'skipped', reason: 'environment_not_ready', setup: 'setting_up' });
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
        // With no Run live, the close still goes to the worker: the sessions that hold the PR's code go with it.
        const idle = await setup({ runs: [], head: closed });
        expect(await idle.useCase.execute(event({ event: 'closed' }))).toEqual({ action: 'skipped', reason: 'nothing_live' });
        expect(idle.cancels()).toEqual([{ organizationId: ORG, repositoryId: REPO, prNumber: 7, reason: 'pr_closed' }]);
        const merged = await setup({ runs: [], head: { ...closed, state: 'merged' } });
        expect(await merged.useCase.execute(event({ event: 'closed' }))).toEqual({ action: 'skipped', reason: 'nothing_live' });
        expect(merged.cancels()).toEqual([{ organizationId: ORG, repositoryId: REPO, prNumber: 7, reason: 'pr_closed' }]);
    });

    it('a late close of a PR open again removes nothing: no Run is cancelled, no session goes', async () => {
        const open = { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'open' as const };
        const reopened = await setup({ runs: [run({ state: 'booting' })], head: open });
        expect(await reopened.useCase.execute(event({ event: 'closed' }))).toEqual({ action: 'skipped', reason: 'pr_still_open' });
        expect(reopened.cancels()).toEqual([]);
    });

    it("a closed PR with nothing live still tells the Runtime, so its Runs' previews end; a comment on a closed PR does not", async () => {
        const closed = { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'closed' as const };
        const s = await setup({ runs: [], head: closed });
        expect(await s.useCase.execute(event({ event: 'closed' }))).toEqual({ action: 'skipped', reason: 'nothing_live' });
        expect(s.cancels()).toEqual([{ organizationId: ORG, repositoryId: REPO, prNumber: 7, reason: 'pr_closed' }]);
        const comment = await setup({ runs: [], head: closed });
        await comment.useCase.execute(event({ event: 'comment', commenter: { id: '42', login: 'maria' } }));
        expect(comment.cancels()).toEqual([]);
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

    it('@kody runtime starts at most the daily number of comment Runs on one PR, and says why it stops', async () => {
        const comment = event({ event: 'comment', commenter: { id: '42', login: 'maria' }, commentId: 'c-new' });
        const recent = new Date().toISOString();
        const sha = (i: number) => i.toString(16).padStart(40, 'd');
        const asked = Array.from({ length: COMMENT_RUNS_PER_PULL_REQUEST_PER_DAY }, (_, i) => run({ trigger: 'comment', headSha: sha(i), requestedAt: recent }));
        const full = await setup({ canWrite: true, runs: asked });
        const outcome = await full.useCase.execute(comment);
        expect(outcome).toMatchObject({ action: 'skipped', reason: 'comment_runs_per_day_reached' });
        expect((outcome as { detail?: string }).detail).toContain(`${COMMENT_RUNS_PER_PULL_REQUEST_PER_DAY} Runs asked by hand`);
        expect(full.requested()).toEqual([]);

        // Older comment Runs and Runs started another way do not count.
        const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        const others = [
            ...asked.slice(1),
            run({ trigger: 'comment', headSha: sha(100), requestedAt: old }),
            run({ trigger: 'pull_request', headSha: sha(101), requestedAt: recent }),
        ];
        expect(await (await setup({ canWrite: true, runs: others })).useCase.execute(comment)).toMatchObject({ action: 'enqueued', trigger: 'comment' });
        // A PR event never reads the cap.
        expect(await (await setup({ runs: asked, settings: [rules({ runOnNewPushes: true })] })).useCase.execute(event())).toMatchObject({ action: 'enqueued', trigger: 'pull_request' });
    });

    it('@kody runtime and the Runs asked from Kodus (Run again, Run on this PR) share one daily count on a pull request', async () => {
        const comment = event({ event: 'comment', commenter: { id: '42', login: 'maria' }, commentId: 'c-new' });
        const recent = new Date().toISOString();
        const sha = (i: number) => i.toString(16).padStart(40, 'd');
        const asked = Array.from({ length: COMMENT_RUNS_PER_PULL_REQUEST_PER_DAY }, (_, i) => run({ trigger: i % 2 ? 'comment' : 'run_again', headSha: sha(i), requestedAt: recent }));
        const full = await setup({ canWrite: true, runs: asked });
        expect(await full.useCase.execute(comment)).toMatchObject({ action: 'skipped', reason: 'comment_runs_per_day_reached' });
        expect(full.requested()).toEqual([]);
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
    describe('a skipped @kody runtime answers on the PR', () => {
        const comment = (patch: Partial<RuntimePullRequestObserved> = {}) => event({ event: 'comment', commenter: { id: '42', login: 'maria' }, commentId: 'c-1', ...patch });

        it('a skipped comment trigger answers once per head and reason', async () => {
            const platform = fakePlatform();
            const publications = new InMemoryPublicationStore();
            const head = { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'open' as const };
            const s = await setup({ setupState: 'setting_up', canWrite: true, head, platform, publications });
            await s.useCase.execute(comment());
            // The same event redelivered, and a second comment on the same head: still one answer.
            await s.useCase.execute(comment());
            await s.useCase.execute(comment({ commentId: 'c-2' }));
            expect(platform.comments.map((c) => c.body.split('\n')[0])).toEqual([
                'Kody Runtime did not run because the environment is still finishing its setup. Wait a few minutes, then comment `@kody runtime` again.',
            ]);
            // Another reason on the same head, and the same reason on a new head, each answer once.
            await (await setup({ setupState: 'blocked', canWrite: true, head, platform, publications })).useCase.execute(comment());
            head.headSha = NEW_SHA;
            await s.useCase.execute(comment({ commentId: 'c-3' }));
            expect(platform.comments).toHaveLength(3);
            expect(platform.comments[1].body).toContain("the environment's setup stopped on a blocker");
            expect(platform.comments[2].body).toContain('still finishing its setup');
        });

        it.each([
            ['off', { settings: [] }, 'it is off for this repository'],
            ['pr_not_open', { head: { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'closed' } }, 'this pull request is closed'],
            ['fork_pull_requests_skipped', { head: { headSha: SHA, baseSha: BASE_SHA, fork: true, state: 'open' }, forkPullRequests: 'skip' }, 'does not run pull requests from forks'],
            ['already_running', { runs: [run({ state: 'testing', headSha: SHA })] }, 'already running on this commit'],
            ['environment_not_ready', { setupState: null }, 'has not been set up yet'],
        ] satisfies Array<[string, Parameters<typeof setup>[0], string]>)('%s: the comment is answered with why and what to do', async (reason, opts, words) => {
            const s = await setup({ canWrite: true, ...opts });
            expect(await s.useCase.execute(comment())).toMatchObject({ action: 'skipped', reason });
            expect(s.platform.comments).toHaveLength(1);
            expect(s.platform.comments[0].body).toContain(words);
        });

        it("a comment past the day's asked Runs answers with the limit every way of asking shares", async () => {
            const recent = new Date().toISOString();
            const asked = Array.from({ length: COMMENT_RUNS_PER_PULL_REQUEST_PER_DAY }, (_, i) => run({ trigger: 'comment', headSha: i.toString(16).padStart(40, 'd'), requestedAt: recent }));
            const s = await setup({ canWrite: true, runs: asked });
            await s.useCase.execute(comment());
            // The shared line, with its mention in code so it notifies no one.
            expect(s.platform.comments[0].body.split('\n')[0]).toBe(ASKED_RUNS_REACHED_DETAIL.replace('@kody runtime', '`@kody runtime`'));
        });

        it('someone who may not ask gets no answer, whatever the reason', async () => {
            const notAllowed = await setup({ canWrite: false });
            expect(await notAllowed.useCase.execute(comment())).toEqual({ action: 'skipped', reason: 'commenter_not_allowed' });
            // A reason decided before the permission check still tells a stranger nothing.
            for (const opts of [{ settings: [] }, { setupState: 'setting_up' as const }]) {
                const s = await setup({ canWrite: false, ...opts });
                await s.useCase.execute(comment());
                expect(s.platform.comments).toEqual([]);
            }
            const anonymous = await setup({ settings: [] });
            await anonymous.useCase.execute(comment({ commenter: undefined }));
            expect(anonymous.platform.comments).toEqual([]);
        });

        it('a skipped PR push or open never answers on the PR', async () => {
            for (const opts of [{ setupState: 'setting_up' as const }, { paths: ['docs/readme.md'] }, { settings: [] }]) {
                const s = await setup(opts);
                await s.useCase.execute(event());
                expect(s.platform.comments).toEqual([]);
            }
        });

        it('an answer whose platform reply was lost is found on the retry, not posted twice', async () => {
            const s = await setup({ setupState: 'setting_up', canWrite: true });
            s.platform.state.loseNextAnswer = true;
            await expect(s.useCase.execute(comment())).rejects.toThrow('socket hang up');
            await s.useCase.execute(comment());
            expect(s.platform.comments).toHaveLength(1);
            expect([...s.publications.rows.values()]).toMatchObject([{ kind: 'skip_reply', status: 'published', comment: { id: 1 } }]);
        });

        it("another author's comment carrying the answer's marker is not taken for Kody's answer", async () => {
            const s = await setup({ setupState: 'setting_up', canWrite: true });
            s.platform.state.loseNextAnswer = true;
            await expect(s.useCase.execute(comment())).rejects.toThrow('socket hang up');
            // The PR author copies Kody's lost post, marker included, and Kody's own is gone.
            const [lost] = s.platform.comments.splice(0, 1);
            s.platform.comments.push({ id: 7, body: lost.body, user: { id: 'pr-author' } });
            await s.useCase.execute(comment());
            expect(s.platform.comments.map((c) => c.user.id)).toEqual(['pr-author', KODY_ACCOUNT]);
            expect([...s.publications.rows.values()]).toMatchObject([{ kind: 'skip_reply', status: 'published', comment: { id: 2 } }]);
        });

        it('the answer carries no internal id', async () => {
            const s = await setup({ setupState: 'setting_up', canWrite: true });
            await s.useCase.execute(comment());
            const [{ body }] = s.platform.comments;
            for (const id of [ORG, TEAM, REPO, SHA, 'env-1', 'c-1']) expect(body).not.toContain(id);
        });
    });
    // A `@kody runtime` on a repository the product's own Git connection cannot
    // serve was silent: an empty PR read became `pr_not_found`, answered only to
    // a commenter the dead connection could not check, and a PAT connection's
    // refused download token failed the event until it dead-lettered.
    describe('a @kody runtime the Git connection cannot serve is answered with what the admin must fix', () => {
        const comment = (patch: Partial<RuntimePullRequestObserved> = {}) => event({ event: 'comment', commenter: { id: '42', login: 'maria' }, commentId: 'c-1', ...patch });
        const patIssuer = () =>
            new CodeManagementRepoTokenIssuer({ getTypeIntegration: async () => PlatformType.GITHUB } as any, {
                issueRepositoryDownloadToken: async () => {
                    throw new RepositoryDownloadTokenError('unsupported_auth', 'A repository download token needs a GitHub App installation');
                },
            });

        it('a repository Kodus can no longer read (the GitHub App removed) answers that an admin must reconnect it', async () => {
            const s = await setup({ head: null, readAccess: 'denied', canWrite: true });
            expect(await s.useCase.execute(comment())).toEqual({ action: 'skipped', reason: 'repository_unreachable' });
            expect(s.platform.comments).toHaveLength(1);
            const [line] = s.platform.comments[0].body.split('\n');
            expect(line).toContain('Kodus cannot reach this repository');
            expect(line).toContain('reinstall the Kodus GitHub App');
            for (const id of [ORG, TEAM, REPO, SHA, 'env-1', 'c-1']) expect(s.platform.comments[0].body).not.toContain(id);
        });

        it('a PR Kodus could not read on a connection that still reads the repository keeps the not-found answer', async () => {
            const s = await setup({ head: null, readAccess: 'unknown', canWrite: true });
            expect(await s.useCase.execute(comment())).toEqual({ action: 'skipped', reason: 'pr_not_found' });
        });

        it('an organization connected with a personal access token is told Kody Runtime cannot use it, and its PR pushes stop retrying', async () => {
            const s = await setup({ canWrite: true, issuer: patIssuer(), settings: [rules({ mode: 'on_request' })] });
            expect(await s.useCase.execute(comment())).toEqual({ action: 'skipped', reason: 'pat_connection' });
            expect(s.platform.comments).toHaveLength(1);
            expect(s.platform.comments[0].body.split('\n')[0]).toContain('personal access token, which Kody Runtime cannot use');
            expect(s.requested()).toEqual([]);

            // A push on the same connection decides the same refusal: dropped, never failed into the broker's retries.
            const push = await setup({ issuer: patIssuer() });
            await expect(push.useCase.execute(event())).resolves.toEqual({ action: 'skipped', reason: 'pat_connection' });
            expect(push.platform.comments).toEqual([]);
        });

        it.each([
            ['the connection cannot say who commented', { canWrite: undefined }, false],
            ['the platform refuses the post', { canWrite: true }, true],
        ] as const)('when %s, it logs one warning and stops: no comment, no retry', async (_label, opts, refuse) => {
            const s = await setup({ head: null, readAccess: 'denied', ...opts });
            s.platform.state.refuseComments = refuse;
            const warn = jest.spyOn((s.useCase as any).logger, 'warn').mockImplementation(() => undefined);
            await expect(s.useCase.execute(comment())).resolves.toEqual({ action: 'skipped', reason: 'repository_unreachable' });
            expect(s.platform.comments).toEqual([]);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toMatchObject({
                message: expect.stringContaining('the comment is not answered'),
                metadata: { organizationId: ORG, repositoryId: REPO, prNumber: 7, reason: 'repository_unreachable' },
            });
            // Nothing the platform said reaches the log.
            expect(JSON.stringify(warn.mock.calls[0][0])).not.toContain('Not Found');
        });
    });
});
