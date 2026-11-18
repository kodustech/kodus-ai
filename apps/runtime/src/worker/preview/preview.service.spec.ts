import { environmentPreviewIdFor, PREVIEW_REASONS, previewIdFor, type PreviewOpen } from '@libs/runtime/contracts/preview';
import type { AcquireRequest, Claim, EnvironmentRuntime } from '@libs/runtime/environment';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { PreviewError, type PreviewHubPort, PreviewService } from './preview.service';
import { InMemoryPreviewStore } from '../../shared/persistence/testing';

// The worker side of preview URLs against an in-memory store, a fake hub and
// a fake environment: what it acquires, what it routes, and when it gives the
// claim back.

const T0 = Date.parse('2026-11-12T12:00:00Z');
const ORG = 'org-a';
const PREVIEW = previewIdFor(ORG, 'run-1', 'pr');

const open = (over: Partial<PreviewOpen> = {}): PreviewOpen => ({
    organizationId: ORG,
    previewId: PREVIEW,
    runId: 'run-1',
    environmentId: 'env-1',
    repositoryId: 'repo-1',
    repositoryFullName: 'acme/shop',
    side: 'pr',
    sha: 'b'.repeat(40),
    sealedRepoToken: 'sealed:v1:opaque',
    openedBy: 'user-1',
    ...over,
});

const setup = { organizationId: ORG, repositoryId: 'repo-1', state: 'active', imageId: 'img-1', expose: [{ service: 'db', port: 5432, kind: 'postgres' }, { service: 'web', port: 3000, kind: 'http' }] } as unknown as EnvironmentSetupRecord;

function harness(opts: { domain?: string; canaries?: boolean; setup?: EnvironmentSetupRecord } = { domain: 'preview.example' }) {
    const record = opts.setup ?? setup;
    let now = T0;
    let labels = 0;
    const store = new InMemoryPreviewStore();
    const acquired: AcquireRequest[] = [];
    const released: string[] = [];
    const renewed: string[] = [];
    const routes: Array<{ claimId: string; previewId: string; target: unknown; until: string }> = [];
    const unroutes: string[] = [];
    const logs: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
    const claim = (req: AcquireRequest): Claim => ({
        claimId: `claim-${acquired.length}`,
        cellId: 'cell-1',
        cellOwner: 'kodus',
        leaseExpiresAt: new Date(now + 15 * 60_000).toISOString(),
        hardExpiresAt: new Date(now + 120 * 60_000).toISOString(),
        observer: { id: 'obs', state: 'ready' },
        manifest: { services: [], expose: setup.expose!, imageId: req.imageId ?? 'img-1', seedSha: 's' },
    });
    const env: EnvironmentRuntime = {
        acquire: async (req) => {
            acquired.push(req);
            return claim(req);
        },
        release: async (id) => void released.push(id),
        renew: async (id) => {
            renewed.push(id);
            return { status: 'renewed', leaseExpiresAt: new Date(now + 15 * 60_000).toISOString(), hardExpiresAt: new Date(T0 + 120 * 60_000).toISOString(), atCeiling: false };
        },
    } as unknown as EnvironmentRuntime;
    const hub: PreviewHubPort = {
        route: async (c, b) => {
            routes.push({ claimId: c.claimId, ...b });
            return true;
        },
        unroute: async (c) => void unroutes.push(c.claimId),
    };
    const service = new PreviewService({
        store,
        setups: { get: async (id) => (id === 'env-1' ? record : null) },
        environment: () => env,
        hub,
        isStopped: async () => false,
        ...(opts.domain ? { domain: opts.domain } : {}),
        now: () => new Date(now),
        // One random host per preview: the first is all q, the next r, and so on.
        hostLabel: (side) => `p-${'qrstuvwxyz'[labels++].repeat(26)}-${side}`,
        log: (level, msg, fields) => void logs.push({ level, msg, fields }),
        ...(opts.canaries ? { canaries: (id: string, start: number) => [{ slot: 'npmrc' as const, value: `npm_${id.slice(4, 12)}${start}` }] } : {}),
    });
    return { service, store, acquired, released, renewed, routes, unroutes, logs, advance: (ms: number) => (now += ms), at: () => now };
}

describe('PreviewService', () => {
    it('opens one side of a Run on its own preview claim and routes its http expose entry', async () => {
        const h = harness();
        const view = await h.service.open(open());
        await h.service.settle();
        expect(view).toMatchObject({ previewId: PREVIEW, host: `p-${'q'.repeat(26)}-pr.preview.example`, state: 'starting', withoutSecrets: true });
        expect(h.acquired).toEqual([expect.objectContaining({ consumer: 'preview', ref: { side: 'pr', sha: 'b'.repeat(40) }, idempotencyKey: `preview:${PREVIEW}:1` })]);
        expect(h.routes).toEqual([{ claimId: 'claim-1', previewId: PREVIEW, target: { service: 'web', port: 3000 }, until: new Date(T0 + 15 * 60_000).toISOString() }]);
        expect((await h.service.status({ organizationId: ORG, previewId: PREVIEW })).state).toBe('ready');
    });

    it("boots an authored recipe with Kody's build files from the setup, as a Run does", async () => {
        const files = [{ path: '.kodus/compose.yaml', content: 'services: {}\n' }];
        const recipe = { path: '.kodus/workspace.yaml', state: 'found', content: 'version: 1\n', digest: 'd1', files };
        const h = harness({ domain: 'preview.example', setup: { ...setup, recipe } as unknown as EnvironmentSetupRecord });
        await h.service.open(open());
        await h.service.settle();
        expect(h.acquired[0]?.recipe).toEqual({ path: '.kodus/workspace.yaml', content: 'version: 1\n', digest: 'd1', files });
        expect((await h.service.status({ organizationId: ORG, previewId: PREVIEW })).state).toBe('ready');
    });

    it('a second open answers the same preview and starts nothing more', async () => {
        const h = harness();
        await h.service.open(open());
        await h.service.settle();
        const again = await h.service.open(open());
        await h.service.settle();
        expect(again.state).toBe('ready');
        expect(h.acquired).toHaveLength(1);
    });

    it("refuses another org's preview as absent", async () => {
        const h = harness();
        await h.service.open(open());
        await h.service.settle();
        await expect(h.service.status({ organizationId: 'org-b', previewId: PREVIEW })).rejects.toMatchObject({ status: 404 });
        await expect(h.service.stop({ organizationId: 'org-b', previewId: PREVIEW })).rejects.toMatchObject({ status: 404 });
    });

    it('is off without a preview domain, and says what to set', async () => {
        const h = harness({});
        const e = await h.service.open(open()).catch((x) => x);
        expect(e).toBeInstanceOf(PreviewError);
        expect(e).toMatchObject({ status: 409, code: 'preview_off' });
        expect(e.message).toContain('RUNTIME_PREVIEW_DOMAIN');
    });

    it('stops after 15 idle minutes, then the next request wakes a new claim', async () => {
        const h = harness();
        await h.service.open(open());
        await h.service.settle();
        h.advance(14 * 60_000);
        expect((await h.service.tick()).slept).toBe(0);
        h.advance(60_000);
        expect((await h.service.tick()).slept).toBe(1);
        expect(h.unroutes).toEqual(['claim-1']);
        expect(h.released).toEqual(['claim-1']);
        expect((await h.service.status({ organizationId: ORG, previewId: PREVIEW })).state).toBe('sleeping');

        // The edge records a viewer's request on the sleeping preview.
        expect(await h.store.requestWake(PREVIEW, new Date(h.at()).toISOString())).toBe(true);
        expect((await h.service.tick()).woken).toBe(1);
        await h.service.settle();
        expect(h.acquired.map((a) => a.idempotencyKey)).toEqual([`preview:${PREVIEW}:1`, `preview:${PREVIEW}:2`]);
        expect((await h.service.status({ organizationId: ORG, previewId: PREVIEW })).state).toBe('ready');
        expect(h.store.audits.map((a) => a.action)).toEqual(['started', 'slept', 'woken']);
    });

    it('traffic keeps it awake: a lease about to end is renewed and the route declared to the new end', async () => {
        const h = harness();
        await h.service.open(open());
        await h.service.settle();
        h.advance(11 * 60_000);
        await h.store.recordActivity(PREVIEW, new Date(h.at()).toISOString());
        expect((await h.service.tick()).renewed).toBe(1);
        expect(h.renewed).toEqual(['claim-1']);
        expect(h.routes.at(-1)!.until).toBe(new Date(h.at() + 15 * 60_000).toISOString());
    });

    it('a wake after the open token is too old asks to open it again from Kodus', async () => {
        const h = harness();
        await h.service.open(open());
        await h.service.settle();
        h.advance(16 * 60_000);
        await h.service.tick();
        h.advance(40 * 60_000);
        await h.store.requestWake(PREVIEW, new Date(h.at()).toISOString());
        expect((await h.service.tick()).woken).toBe(0);
        expect(h.store.previews.get(PREVIEW)).toMatchObject({ state: 'sleeping', reason: 'reopen' });
        expect(h.acquired).toHaveLength(1);
        // Opening it again from Kodus brings a fresh token and starts it.
        await h.service.open(open());
        await h.service.settle();
        expect(h.acquired).toHaveLength(2);
    });

    it('stop gives the claim back and ends its sessions; the record ends after 7 days', async () => {
        const h = harness();
        await h.service.open(open());
        await h.service.settle();
        await h.store.createSession({ sessionHash: 'h', previewId: PREVIEW, organizationId: ORG, userId: 'user-1', createdAt: 'x', expiresAt: 'y' });
        expect((await h.service.stop({ organizationId: ORG, previewId: PREVIEW, actor: 'user-1' })).state).toBe('stopped');
        expect(h.released).toEqual(['claim-1']);
        expect(h.store.sessions.get('h')!.closedAt).toBeDefined();

        const other = harness();
        await other.service.open(open());
        await other.service.settle();
        other.advance(7 * 86_400_000);
        await other.service.tick();
        expect((await other.service.status({ organizationId: ORG, previewId: PREVIEW })).state).toBe('expired');
        await expect(other.service.open(open())).rejects.toMatchObject({ code: 'preview_expired' });
    });

    describe('phase 2', () => {
        const withPolicy = (policy: NonNullable<PreviewOpen['policy']>, over: Partial<PreviewOpen> = {}) => open({ policy, ...over });
        const POLICY = { idleMinutes: 15, ceilingMinutes: 120, secrets: false, forkPullRequest: false };

        it("sleeps after the org's idle timeout and at the org's ceiling, not the defaults", async () => {
            const h = harness();
            await h.service.open(withPolicy({ ...POLICY, idleMinutes: 5 }));
            await h.service.settle();
            h.advance(5 * 60_000);
            expect((await h.service.tick()).slept).toBe(1);

            const c = harness();
            await c.service.open(withPolicy({ ...POLICY, ceilingMinutes: 30 }));
            await c.service.settle();
            // Used all along: traffic every few minutes, yet one start ends at its 30 minutes.
            for (let m = 0; m < 6; m++) {
                c.advance(5 * 60_000);
                await c.store.recordActivity(PREVIEW, new Date(c.at()).toISOString());
                await c.service.tick();
            }
            expect(c.store.previews.get(PREVIEW)!.state).toBe('sleeping');
            expect(c.store.audits.at(-1)).toMatchObject({ action: 'slept', reason: 'ceiling' });
        });

        it("refuses an open past the org's monthly cap, and blocks a wake past it with the reason", async () => {
            const h = harness();
            const month = '2026-11-01T00:00:00.000Z';
            const claim = (minutes: number) => ({ claimId: `old-${minutes}`, cellId: 'c', side: 'pr', state: 'released', driver: null, bootMb: null, readyMb: null, allocatableMb: null, admittedAt: month, readyAt: month, releasedAt: new Date(Date.parse(month) + minutes * 60_000).toISOString(), stateChangedAt: null, hardExpiresAt: null, organizationId: ORG, consumer: 'preview', createdAt: month });
            h.store.claims.push(claim(90));
            await expect(h.service.open(withPolicy({ ...POLICY, monthlyMachineMinutes: 60 }))).rejects.toMatchObject({ status: 409, code: 'preview_cap' });
            expect(h.acquired).toHaveLength(0);
            // Under the cap it opens; once the month's time is used up, the next wake boots nothing.
            h.store.claims.length = 0;
            await h.service.open(withPolicy({ ...POLICY, monthlyMachineMinutes: 60 }));
            await h.service.settle();
            h.advance(16 * 60_000);
            await h.service.tick();
            h.store.claims.push(claim(61));
            await h.store.requestWake(PREVIEW, new Date(h.at()).toISOString());
            expect((await h.service.tick()).woken).toBe(0);
            expect(h.store.previews.get(PREVIEW)).toMatchObject({ state: 'blocked', reason: PREVIEW_REASONS.cap });
            expect(h.acquired).toHaveLength(1);
        });

        it('boots a fork\'s PR side without approved hosts or secrets, and an environment set to "same as the Run" with them', async () => {
            const h = harness({ domain: 'preview.example', canaries: true });
            await h.service.open(withPolicy({ ...POLICY, secrets: true, forkPullRequest: true }));
            await h.service.settle();
            expect(h.acquired[0]).toMatchObject({ forkPullRequest: true });
            expect(h.acquired[0]).not.toHaveProperty('previewSecrets');
            expect((await h.service.status({ organizationId: ORG, previewId: PREVIEW })).withoutSecrets).toBe(true);

            const base = previewIdFor(ORG, 'run-1', 'base');
            await h.service.open(withPolicy({ ...POLICY, secrets: true, forkPullRequest: true }, { previewId: base, side: 'base', sha: 'a'.repeat(40) }));
            await h.service.settle();
            expect(h.acquired[1]).toMatchObject({ previewSecrets: true });
            expect(h.acquired[1]).not.toHaveProperty('forkPullRequest');
            expect((await h.service.status({ organizationId: ORG, previewId: base })).withoutSecrets).toBe(false);
            // Each start plants its own decoys.
            expect(h.acquired.map((a) => a.canaries?.length)).toEqual([1, 1]);
        });

        it('a security event on the preview claim stops it and ends its sessions; the machines stay as evidence', async () => {
            const h = harness();
            await h.service.open(open());
            await h.service.settle();
            await h.store.createSession({ sessionHash: 'h', previewId: PREVIEW, organizationId: ORG, userId: 'user-1', createdAt: 'x', expiresAt: 'y' });
            // Another org's blocker on the same claim id is not this preview's.
            h.store.violations.set('claim-1', { organizationId: 'org-b', signature: 'canary_egress' });
            await h.service.tick();
            expect(h.store.previews.get(PREVIEW)!.state).toBe('ready');
            h.store.violations.set('claim-1', { organizationId: ORG, signature: 'canary_egress' });
            await h.service.tick();
            expect(h.store.previews.get(PREVIEW)).toMatchObject({ state: 'stopped', reason: PREVIEW_REASONS.security });
            expect(h.store.sessions.get('h')!.closedAt).toBeDefined();
            expect(h.unroutes).toEqual(['claim-1']);
            expect(h.released).toEqual([]);
            expect(h.store.audits.at(-1)).toMatchObject({ action: 'stopped', reason: 'security_event' });
            // A stopped-by-security preview is not woken by a viewer.
            expect(await h.store.requestWake(PREVIEW, new Date(h.at()).toISOString())).toBe(false);
        });

        it('a security read that fails is logged as an error, not taken as no violation in silence, and the tick goes on', async () => {
            const h = harness();
            await h.service.open(open());
            await h.service.settle();
            h.store.securityViolations = async () => Promise.reject(Object.assign(new Error('db down'), { code: 'ECONNRESET' }));
            h.advance(15 * 60_000);
            expect((await h.service.tick()).slept).toBe(1);
            expect(h.logs).toContainEqual({ level: 'error', msg: 'preview.security_read_failed', fields: { claims: 1, error: { kind: 'network', code: 'ECONNRESET' } } });
        });

        it("a newer Run of the pull request ends the older Runs' previews, and its closing ends every one", async () => {
            const h = harness();
            await h.service.open(open({ prNumber: 7 }));
            const second = previewIdFor(ORG, 'run-2', 'pr');
            await h.service.open(open({ prNumber: 7, previewId: second, runId: 'run-2' }));
            const otherPr = previewIdFor(ORG, 'run-3', 'pr');
            await h.service.open(open({ prNumber: 8, previewId: otherPr, runId: 'run-3' }));
            await h.service.settle();
            expect(await h.service.expirePullRequest({ organizationId: ORG, repositoryId: 'repo-1', prNumber: 7, keepRunId: 'run-2', why: 'newer_run' })).toBe(1);
            expect(h.store.previews.get(PREVIEW)).toMatchObject({ state: 'expired', reason: PREVIEW_REASONS.newerRun });
            expect(h.store.previews.get(second)!.state).toBe('ready');
            // Another org's pull request of the same number is not touched.
            expect(await h.service.expirePullRequest({ organizationId: 'org-b', repositoryId: 'repo-1', prNumber: 7, why: 'pr_closed' })).toBe(0);
            expect(await h.service.expirePullRequest({ organizationId: ORG, repositoryId: 'repo-1', prNumber: 7, why: 'pr_closed' })).toBe(1);
            expect(h.store.previews.get(second)).toMatchObject({ state: 'expired', reason: PREVIEW_REASONS.prClosed });
            expect(h.store.previews.get(otherPr)!.state).toBe('ready');
            expect(h.released).toEqual(['claim-1', 'claim-2']);
        });

        it("an environment's preview of a newer bake ends the older one", async () => {
            const h = harness();
            const first = environmentPreviewIdFor(ORG, 'env-1', 'a'.repeat(40));
            await h.service.open(open({ previewId: first, runId: undefined, side: 'base', sha: 'a'.repeat(40) }));
            await h.service.settle();
            const next = environmentPreviewIdFor(ORG, 'env-1', 'c'.repeat(40));
            const view = await h.service.open(open({ previewId: next, runId: undefined, side: 'base', sha: 'c'.repeat(40) }));
            await h.service.settle();
            expect(view).not.toHaveProperty('runId');
            expect(h.store.previews.get(first)).toMatchObject({ state: 'expired', reason: PREVIEW_REASONS.newerSetup });
            expect(h.store.previews.get(next)!.state).toBe('ready');
        });
    });
});
