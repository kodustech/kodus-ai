import { Pool } from 'pg';

import { previewIdFor, previewTicketHash } from '@libs/runtime/contracts/preview';

import { isolatedDatabase } from '../../testing/isolated-database';
import { PgPreviewStore, type PreviewRow, type PreviewStore } from './preview-store';
import { ensureRuntimeSchema } from './runtime-schema';
import { InMemoryPreviewStore } from './testing';

// The preview store on real Postgres (migrations 27 and 28) and in memory, held to
// the same behaviour. Opt-in like the other stores: RUNTIME_IT_DATABASE_URL.

const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'preview_store');
const skip = !database.url || process.env.SKIP_INTEGRATION === 'true';
const T = '2026-11-12T12:00:00.000Z';
const LATER = '2026-11-19T12:00:00.000Z';

const row = (org = 'org-a', run = 'run-1', host = `p-${'a'.repeat(26)}-pr.preview.example`): PreviewRow => ({
    previewId: previewIdFor(org, run, 'pr'),
    organizationId: org,
    environmentId: 'env-1',
    repositoryId: 'repo-1',
    repositoryFullName: 'acme/shop',
    runId: run,
    side: 'pr',
    sha: 'a'.repeat(40),
    host,
    state: 'starting',
    openedBy: 'user-1',
    withoutSecrets: true,
    forkPullRequest: false,
    starts: 1,
    sealedRepoToken: 'sealed:v1:opaque',
    tokenSealedAt: T,
    createdAt: T,
    updatedAt: T,
    expiresAt: LATER,
});

(skip ? describe.skip : describe)('preview store (integration, real Postgres and in memory)', () => {
    let pool: Pool;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: database.url, max: 4 });
        await ensureRuntimeSchema(pool);
    });

    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    const both = (): Array<[string, () => Promise<PreviewStore>]> => [
        ['postgres', async () => {
            await pool.query('TRUNCATE runtime.runtime_previews, runtime.runtime_preview_sessions, runtime.runtime_preview_grants_used, runtime.runtime_preview_tunnel_tickets, runtime.runtime_preview_tunnels, runtime.runtime_preview_audit');
            return new PgPreviewStore(pool);
        }],
        ['memory', async () => new InMemoryPreviewStore()],
    ];

    it.each(both())('%s: a preview is one row per id and host, read only by its own org', async (_n, make) => {
        const s = await make();
        expect(await s.insertPreview(row())).toBe(true);
        expect(await s.insertPreview(row())).toBe(false);
        expect(await s.getPreview('org-b', row().previewId)).toBeNull();
        expect(await s.getPreview('org-a', row().previewId)).toEqual(row());
        expect((await s.previewByHost(row().host.toUpperCase()))?.previewId).toBe(row().previewId);
    });

    it.each(both())('%s: a transition applies only from the states it names, and undefined clears a column', async (_n, make) => {
        const s = await make();
        await s.insertPreview(row());
        const id = row().previewId;
        expect(await s.updatePreview('org-a', id, { state: 'ready', claimId: 'claim-1', target: { service: 'web', port: 3000 }, updatedAt: T }, ['starting'])).toBe(true);
        expect(await s.updatePreview('org-a', id, { state: 'sleeping' }, ['starting'])).toBe(false);
        expect(await s.updatePreview('org-b', id, { state: 'stopped' })).toBe(false);
        expect(await s.getPreview('org-a', id)).toMatchObject({ state: 'ready', claimId: 'claim-1', target: { service: 'web', port: 3000 } });
        await s.updatePreview('org-a', id, { state: 'sleeping', claimId: undefined, target: undefined }, ['ready']);
        const slept = (await s.getPreview('org-a', id))!;
        expect(slept.claimId).toBeUndefined();
        expect(slept.target).toBeUndefined();
        expect((await s.listOpenPreviews(10)).map((p) => p.previewId)).toEqual([id]);
    });

    it.each(both())('%s: a wake is recorded only on a sleeping or blocked preview; activity only moves forward', async (_n, make) => {
        const s = await make();
        await s.insertPreview(row());
        const id = row().previewId;
        expect(await s.requestWake(id, T)).toBe(false);
        await s.updatePreview('org-a', id, { state: 'sleeping' });
        expect(await s.requestWake(id, T)).toBe(true);
        await s.recordActivity(id, '2026-11-12T12:05:00.000Z');
        await s.recordActivity(id, '2026-11-12T12:01:00.000Z');
        expect((await s.getPreview('org-a', id))!.lastActivityAt).toBe('2026-11-12T12:05:00.000Z');
    });

    it.each(both())('%s: a grant and a tunnel ticket are single-use; a ticket is only its own cell\'s', async (_n, make) => {
        const s = await make();
        expect(await s.useGrant('jti-1', LATER)).toBe(true);
        expect(await s.useGrant('jti-1', LATER)).toBe(false);
        await s.insertTunnelTicket(previewTicketHash('t1'), 'cell-1', LATER);
        expect(await s.consumeTunnelTicket(previewTicketHash('t1'), 'cell-2', T)).toBe(false);
        await s.insertTunnelTicket(previewTicketHash('t2'), 'cell-1', LATER);
        expect(await s.consumeTunnelTicket(previewTicketHash('t2'), 'cell-1', T)).toBe(true);
        expect(await s.consumeTunnelTicket(previewTicketHash('t2'), 'cell-1', T)).toBe(false);
        await s.insertTunnelTicket(previewTicketHash('t3'), 'cell-1', T);
        expect(await s.consumeTunnelTicket(previewTicketHash('t3'), 'cell-1', T)).toBe(false);
    });

    it.each(both())('%s: sessions close with their preview; tunnel holders are per replica', async (_n, make) => {
        const s = await make();
        await s.createSession({ sessionHash: 'h1', previewId: 'prv_x', organizationId: 'org-a', userId: 'u', createdAt: T, expiresAt: LATER });
        expect(await s.closeSessionsOf('prv_x', T)).toBe(1);
        expect((await s.getSession('h1'))!.closedAt).toBe(T);
        await s.holdTunnel('cell-1', 'edge-1', T);
        expect(await s.tunnelHeld('cell-1', T)).toBe(true);
        expect(await s.tunnelHeld('cell-1', LATER)).toBe(false);
        await s.releaseTunnel('cell-1', 'edge-2');
        expect(await s.tunnelHeld('cell-1', T)).toBe(true);
        await s.releaseTunnel('cell-1', 'edge-1');
        expect(await s.tunnelHeld('cell-1', T)).toBe(false);
        await s.audit({ organizationId: 'org-a', previewId: 'prv_x', action: 'session_opened', actor: 'u' });
    });

    it.each(both())("%s: a pull request's and an environment's open previews are found by their own org only; a holder names its URL", async (_n, make) => {
        const s = await make();
        await s.insertPreview({ ...row('org-a', 'run-1'), prNumber: 7 });
        await s.insertPreview({ ...row('org-b', 'run-1', `p-${'b'.repeat(26)}-pr.preview.example`), prNumber: 7 });
        const env = { ...row('org-a', 'env', `p-${'c'.repeat(26)}-base.preview.example`), side: 'base' as const };
        delete (env as Partial<PreviewRow>).runId;
        await s.insertPreview(env);
        expect((await s.openPreviewsOfPullRequest('org-a', 'repo-1', 7)).map((p) => p.organizationId)).toEqual(['org-a']);
        expect(await s.openPreviewsOfPullRequest('org-a', 'repo-1', 8)).toEqual([]);
        const envs = await s.openEnvironmentPreviews('org-a', 'env-1');
        expect(envs.map((p) => p.previewId)).toEqual([env.previewId]);
        expect(envs[0].runId).toBeUndefined();
        expect(await s.openEnvironmentPreviews('org-b', 'env-1')).toEqual([]);
        await s.holdTunnel('cell-1', 'edge-1', T, 'http://10.0.1.5:3430');
        expect(await s.tunnelHolder('cell-1', T)).toEqual({ replica: 'edge-1', url: 'http://10.0.1.5:3430' });
        expect(await s.tunnelHolder('cell-1', LATER)).toBeNull();
    });

    it("postgres: a claim's security violation is read only for its own org; the cap counts the org's preview claims of the month", async () => {
        const s = new PgPreviewStore(pool);
        await pool.query(
            `INSERT INTO runtime.runtime_claim_blockers (claim_id, org_id, cell_id, side, kind, signature, message, at) VALUES ('it-claim-1', 'org-a', 'cell-1', 'pr', 'security_violation', 'canary_egress', '', $1) ON CONFLICT DO NOTHING`,
            [T],
        );
        expect(await s.securityViolations([{ organizationId: 'org-a', claimId: 'it-claim-1' }, { organizationId: 'org-a', claimId: 'it-claim-2' }])).toEqual(new Map([['it-claim-1', 'canary_egress']]));
        expect(await s.securityViolations([{ organizationId: 'org-b', claimId: 'it-claim-1' }])).toEqual(new Map());
        for (const [id, org, consumer, created] of [['it-p1', 'org-a', 'preview', T], ['it-p2', 'org-a', 'runtime', T], ['it-p3', 'org-b', 'preview', T], ['it-p4', 'org-a', 'preview', '2026-10-31T00:00:00.000Z']]) {
            await pool.query(
                `INSERT INTO runtime.runtime_claims (claim_id, cell_id, org_id, side, state, lease_expires_at, hard_expires_at, created_at, admitted_at, released_at, consumer)
                 VALUES ($1, 'cell-1', $2, 'pr', 'released', $3, $3, $4, $4, $3, $5) ON CONFLICT DO NOTHING`,
                [id, org, LATER, created, consumer],
            );
        }
        const claims = await s.previewClaimsSince('org-a', '2026-11-01T00:00:00.000Z');
        expect(claims.map((c) => c.claimId)).toEqual(['it-p1']);
        expect(claims[0]).toMatchObject({ admittedAt: T, releasedAt: LATER, state: 'released' });
    });

    it('postgres: a certificate counts only while the cell row pins its serial', async () => {
        const s = new PgPreviewStore(pool);
        await pool.query(
            `INSERT INTO runtime.runtime_cells (cell_id, owner, topology, status, certificate_serial, certificate_expires_at) VALUES ('it-preview-cell', 'kodus', 'managed', 'active', '0AB12', $1) ON CONFLICT (cell_id) DO NOTHING`,
            [LATER],
        );
        expect(await s.cellCertificatePinned('it-preview-cell', 'ab12', T)).toBe(true);
        expect(await s.cellCertificatePinned('it-preview-cell', 'ab13', T)).toBe(false);
        expect(await s.cellCertificatePinned('it-preview-cell', 'ab12', '2026-11-20T00:00:00.000Z')).toBe(false);
    });
});
