import { runtimePushOutboxMessage, type RuntimeDefaultBranchPushObserved } from '@libs/runtime/run';

import { RuntimeDefaultBranchPushSetup } from '../application/default-branch-push-setup.service';
import { RuntimeEnvironmentMembers } from '../application/environment-members.service';
import { DEFAULT_PUSH_SETUP_DAILY_LIMIT, PUSH_SETUP_STALE_MS } from '../domain/push-setup';
import type { DefaultBranchHead, ProductEnvironment } from '../domain/ports';
import { InMemoryPushSetupLedger } from '../testing';
import { NOW, ORG, REPO, runtimeReleaseGate, SHA, TEAM } from './fixtures';

const NEW_SHA = 'c'.repeat(40);
const THIRD_SHA = 'd'.repeat(40);
const KEY = { organizationId: ORG, environmentId: 'env-1', sha: SHA };
const iso = (ms: number) => new Date(ms).toISOString();

const env = (patch: Partial<ProductEnvironment> = {}): ProductEnvironment => ({
    environmentId: 'env-1',
    organizationId: ORG,
    teamId: TEAM,
    repositoryId: REPO,
    repositoryName: 'acme/shop',
    state: 'active',
    createdAt: iso(NOW.getTime() - 86_400_000),
    updatedAt: iso(NOW.getTime() - 86_400_000),
    ...patch,
});

const push = (patch: Partial<RuntimeDefaultBranchPushObserved> = {}): RuntimeDefaultBranchPushObserved => ({
    organizationId: ORG,
    teamId: TEAM,
    repository: { id: REPO, name: 'acme/shop' },
    branch: 'main',
    headSha: SHA,
    observedAt: NOW.toISOString(),
    ...patch,
});

type Record = NonNullable<Awaited<ReturnType<ConstructorParameters<typeof RuntimeDefaultBranchPushSetup>[4]['get']>>>;
const record = (patch: Partial<Record> = {}) =>
    ({ environmentId: 'env-1', organizationId: ORG, repositoryId: REPO, key: 'k', state: 'active', steps: [], blockers: [], sha: 'e'.repeat(40), requestedAt: iso(NOW.getTime() - 3_600_000), updatedAt: iso(NOW.getTime() - 3_000_000), ...patch }) as Record;

function setup(opts: { env?: ProductEnvironment | null; head?: DefaultBranchHead; record?: Record | null; dailyLimit?: number; enabled?: boolean; requestThrows?: boolean; now?: () => Date } = {}) {
    const environment = opts.env === undefined ? env() : opts.env;
    const ledger = new InMemoryPushSetupLedger();
    const requested: Array<{ environmentId: string; user: unknown }> = [];
    let current = environment;
    const environments = {
        get: async (org: string, id: string) => (current && current.organizationId === org && current.environmentId === id ? current : null),
        findByRepository: async (org: string, repositoryId: string) => (current && current.organizationId === org && current.repositoryId === repositoryId ? current : null),
    };
    const requester = {
        request: async (e: ProductEnvironment, user: unknown) => {
            if (opts.requestThrows) throw new Error('boom');
            requested.push({ environmentId: e.environmentId, user });
            // What the real requester does to the product row.
            current = { ...e, state: 'setup_requested', setupRequestedAt: (opts.now?.() ?? NOW).toISOString() };
            return current;
        },
    };
    let headSha = SHA;
    let setupRecord = opts.record === undefined ? null : opts.record;
    const svc = new RuntimeDefaultBranchPushSetup(
        ledger,
        environments,
        RuntimeEnvironmentMembers.primaryOnly(environments),
        { getDefaultBranchHead: async () => opts.head ?? { status: 'ok', branch: 'main', sha: headSha } },
        { get: async () => setupRecord },
        requester,
        runtimeReleaseGate(opts.enabled ?? true),
        { dailyLimit: opts.dailyLimit ?? DEFAULT_PUSH_SETUP_DAILY_LIMIT },
        opts.now ?? (() => NOW),
    );
    return { svc, ledger, requested, setHead: (sha: string) => (headSha = sha), setRecord: (r: Record | null) => (setupRecord = r), finishSetup: () => (current = current && { ...current, state: 'active' }) };
}

const outcomes = async (svc: RuntimeDefaultBranchPushSetup, p = push()) => (await svc.onPush(p)).map((o) => (o.action === 'skipped' ? o.reason : o.action));

describe('a push to an environment default branch sets it up again', () => {
    it('a push to the default branch of a repository in an environment requests one setup, at the commit the Git API reports', async () => {
        const t = setup();
        expect(await outcomes(t.svc)).toEqual(['requested']);
        expect(t.requested).toHaveLength(1);
        expect(t.requested[0].environmentId).toBe('env-1');
    });

    it('the setup is asked by the Runtime itself, not by a person', async () => {
        const t = setup();
        await t.svc.onPush(push());
        expect(t.requested[0].user).toMatchObject({ uuid: expect.stringContaining('push') });
    });

    it('does nothing when the pushed branch is not the default branch the Git API names', async () => {
        const t = setup({ head: { status: 'ok', branch: 'trunk', sha: SHA } });
        expect(await outcomes(t.svc, push({ branch: 'main' }))).toEqual(['not_default_branch']);
        expect(t.requested).toHaveLength(0);
        expect(t.ledger.rows.size).toBe(0);
    });

    it('does nothing for a repository that is in no environment', async () => {
        const t = setup({ env: null });
        expect(await outcomes(t.svc)).toEqual([]);
        expect(t.requested).toHaveLength(0);
    });

    it('does nothing for a repository of another organization', async () => {
        const t = setup({ env: env({ organizationId: 'org-z' }) });
        expect(await outcomes(t.svc)).toEqual([]);
        expect(t.requested).toHaveLength(0);
    });

    it('does nothing when the organization has no Runtime', async () => {
        const t = setup({ enabled: false });
        expect(await outcomes(t.svc)).toEqual(['not_enabled']);
        expect(t.requested).toHaveLength(0);
    });

    it('does nothing when the Git API cannot name the default branch head', async () => {
        const t = setup({ head: { status: 'unsupported_platform', platform: 'gitlab' } });
        expect(await outcomes(t.svc)).toEqual(['unreadable_head']);
        expect(t.requested).toHaveLength(0);
    });

    it('drops an event that is not a push event', async () => {
        const t = setup();
        expect(await t.svc.onPush({ nope: true })).toEqual([{ action: 'skipped', reason: 'invalid_event' }]);
    });

    it('accepts the outbox envelope the webhook handler writes', async () => {
        const t = setup();
        const message = runtimePushOutboxMessage(push(), 'm-1');
        expect(await outcomes(t.svc, message.payload as never)).toEqual(['requested']);
    });

    it('a push while a setup is queued does not start another one, and the newest commit waits', async () => {
        const t = setup();
        await t.svc.onPush(push());
        const second = await t.svc.onPush(push());
        expect(second).toEqual([{ action: 'skipped', reason: 'coalesced', environmentId: 'env-1' }]);
        expect(t.requested).toHaveLength(1);
        expect((await t.ledger.listPending(10)).length).toBe(1);
    });

    it('the newest commit runs once after the running setup finishes, however many pushes came meanwhile', async () => {
        const t = setup();
        await t.svc.onPush(push());
        // Two more pushes while the first setup runs.
        t.setRecord(record({ state: 'setting_up', sha: SHA, requestedAt: NOW.toISOString(), updatedAt: NOW.toISOString() }));
        t.setHead(NEW_SHA);
        await t.svc.onPush(push({ headSha: NEW_SHA }));
        t.setHead(THIRD_SHA);
        await t.svc.onPush(push({ headSha: THIRD_SHA }));
        expect(await t.ledger.listPending(10)).toEqual([{ ...KEY, sha: THIRD_SHA }]);
        expect(t.requested).toHaveLength(1);
        // The first setup is done; the drain asks once for what is pending.
        t.setRecord(record({ state: 'active', sha: SHA, requestedAt: NOW.toISOString(), updatedAt: NOW.toISOString() }));
        t.finishSetup();
        expect(await t.svc.drain(10)).toEqual({ pending: 1, requested: 1, skipped: 0 });
        expect(t.requested).toHaveLength(2);
        expect(await t.svc.drain(10)).toEqual({ pending: 0, requested: 0, skipped: 0 });
    });

    it('a running setup that already is at the pushed commit is enough', async () => {
        const t = setup({ record: record({ state: 'setting_up', sha: SHA, updatedAt: NOW.toISOString() }), env: env({ state: 'setup_requested', setupRequestedAt: NOW.toISOString() }) });
        expect(await outcomes(t.svc)).toEqual(['already_at_sha']);
        expect(t.requested).toHaveLength(0);
        expect(await t.ledger.listPending(10)).toEqual([]);
    });

    it('an environment already set up at the pushed commit is not rebuilt', async () => {
        const t = setup({ record: record({ state: 'active', sha: SHA }) });
        expect(await outcomes(t.svc)).toEqual(['already_at_sha']);
        expect(t.requested).toHaveLength(0);
    });

    it('a setup nobody has touched for hours does not hold the push back', async () => {
        const stale = iso(NOW.getTime() - PUSH_SETUP_STALE_MS - 60_000);
        const t = setup({ record: record({ state: 'setting_up', sha: 'e'.repeat(40), updatedAt: stale }), env: env({ state: 'setup_requested', setupRequestedAt: stale }) });
        expect(await outcomes(t.svc)).toEqual(['requested']);
    });

    it('the daily budget stops the push after the limit, and a new UTC day starts it again', async () => {
        let now = NOW;
        const t = setup({ dailyLimit: 2, now: () => now });
        for (let i = 0; i < 3; i++) {
            expect(await outcomes(t.svc, push({ headSha: String(i).repeat(40) }))).toEqual([i < 2 ? 'requested' : 'budget_spent']);
            t.finishSetup();
        }
        expect(t.requested).toHaveLength(2);
        // The skipped commit is dropped, not retried by the drain.
        expect(await t.svc.drain(10)).toMatchObject({ pending: 0 });
        now = new Date(NOW.getTime() + 24 * 3_600_000);
        expect(await outcomes(t.svc)).toEqual(['requested']);
    });

    it('with a limit of zero the push trigger is off', async () => {
        const t = setup({ dailyLimit: 0 });
        expect(await outcomes(t.svc)).toEqual(['budget_spent']);
        expect(t.requested).toHaveLength(0);
    });

    it('a setup request that fails gives the commit and the budget back, for the next drain', async () => {
        const t = setup({ requestThrows: true });
        await expect(t.svc.onPush(push())).rejects.toThrow('boom');
        expect(await t.ledger.listPending(10)).toEqual([KEY]);
        expect(t.ledger.rows.get(`${ORG}\u0000env-1`)?.count).toBe(0);
    });
});
