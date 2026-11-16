import { previewIdFor, previewTicketHash } from '@libs/runtime/contracts/preview';

import type { ClaimRow } from '../hub-store';
import { ClaimScopeError, type ClaimRef } from '../hub-types';
import { ClaimPreviewService } from './claim-preview.service';

// The hub declares a preview route only on a bound preview claim of a cell
// that names the feature, and gives the cell a one-time ticket for the edge
// that the edge alone can redeem (only its hash is stored).

const PREVIEW = previewIdFor('org-a', 'run-1', 'pr');
const BODY = { previewId: PREVIEW, target: { service: 'web', port: 3000 }, until: '2026-11-12T12:15:00.000Z' };

function harness(claim: Partial<ClaimRow> = {}, features = ['preview']) {
    const sent: Array<{ type: string; body: Record<string, unknown>; claimId?: string }> = [];
    const tickets: Array<{ hash: string; cellId: string; expiresAt: string }> = [];
    const row: ClaimRow = { claimId: 'claim-1', cellId: 'cell-1', orgId: 'org-a', side: 'pr', state: 'bound', hardExpiresAt: '2026-11-12T14:00:00.000Z', consumer: 'preview', ...claim };
    const service = new ClaimPreviewService(
        {
            scoped: async (ref: ClaimRef) => {
                if (ref.organizationId !== row.orgId) throw new ClaimScopeError('not this tenant');
                return ref.claimId === row.claimId ? row : null;
            },
        },
        {
            get: () => ({ features }) as never,
            request: async (_cellId: string, type: string, body: unknown, claimId?: string) => {
                sent.push({ type, body: body as Record<string, unknown>, claimId });
                return { type: 'ack' } as never;
            },
        },
        { insertTunnelTicket: async (hash, cellId, expiresAt) => void tickets.push({ hash, cellId, expiresAt }) },
        'wss://edge.preview.example/v1/cells/tunnel',
        () => undefined,
        () => new Date('2026-11-12T12:00:00Z'),
    );
    return { service, sent, tickets };
}

describe('ClaimPreviewService', () => {
    it('sends preview.tunnel with a one-time ticket, then preview.route on the claim', async () => {
        const h = harness();
        expect(await h.service.route({ claimId: 'claim-1', organizationId: 'org-a' }, BODY)).toEqual({ ok: true });
        expect(h.sent.map((s) => s.type)).toEqual(['preview.tunnel', 'preview.route']);
        const ticket = h.sent[0].body.ticket as string;
        expect(h.sent[0].body).toEqual({ url: 'wss://edge.preview.example/v1/cells/tunnel', ticket, expiresAt: '2026-11-12T12:01:00.000Z' });
        expect(h.tickets).toEqual([{ hash: previewTicketHash(ticket), cellId: 'cell-1', expiresAt: '2026-11-12T12:01:00.000Z' }]);
        expect(JSON.stringify(h.tickets)).not.toContain(ticket);
        expect(h.sent[1]).toEqual({ type: 'preview.route', body: BODY, claimId: 'claim-1' });
    });

    it("never routes a Run's claim, an unbound claim, or a cell without the feature", async () => {
        for (const [claim, features, code] of [
            [{ consumer: 'runtime' }, ['preview'], 'not_preview_claim'],
            [{ state: 'pending' }, ['preview'], 'claim_not_bound'],
            [{}, ['sandbox'], 'preview_unsupported'],
        ] as const) {
            const h = harness(claim as Partial<ClaimRow>, [...features]);
            expect(await h.service.route({ claimId: 'claim-1', organizationId: 'org-a' }, BODY)).toMatchObject({ ok: false, code });
            expect(h.sent).toEqual([]);
        }
    });

    it("refuses another org's claim before anything reaches the cell", async () => {
        const h = harness();
        await expect(h.service.route({ claimId: 'claim-1', organizationId: 'org-b' }, BODY)).rejects.toBeInstanceOf(ClaimScopeError);
        await expect(h.service.unroute({ claimId: 'claim-1', organizationId: 'org-b' }, PREVIEW)).rejects.toBeInstanceOf(ClaimScopeError);
        expect(h.sent).toEqual([]);
    });
});
