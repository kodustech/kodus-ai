import { classifyBlocker } from '@libs/runtime/blockers/catalog';

import { type Blocked, isCapacityWait } from './environment-runtime';
import { blockerKindOf, typedBlocked } from './typed-blocker';

// A blocked acquire as the port's callers read it (docs §5): a kind among
// BLOCKER_KINDS, and the card the shared catalog gives it (title, evidence,
// fixes). The setup record keeps the blocker's id, state and seen.

describe('a typed blocked acquire', () => {
    it('a known blocker comes back typed, with the catalog’s title and fixes', () => {
        const raw: Blocked = { status: 'blocked', blockers: [{ kind: 'resources', signature: 'no_capacity', message: 'every cell that may serve this organization is full; the claim was not started' }] };
        const [b] = typedBlocked(raw).blockers;
        const card = classifyBlocker({ kind: 'resources', signature: 'no_capacity', message: raw.blockers[0].message });
        expect(b.kind).toBe('resources');
        expect(b.title).toBe(card.title);
        expect(b.fixes).toEqual(card.fixes);
        expect(b.fixes!.length).toBeGreaterThan(0);
        expect(b.evidence).toEqual({ lines: card.evidence.lines });
    });

    it('an unknown kind reads unknown, its signature and message kept', () => {
        const raw = { status: 'blocked', blockers: [{ kind: 'quantum_flux', signature: 'flux_capacitor', message: 'a kind a newer hub knows' }] } as unknown as Blocked;
        const [b] = typedBlocked(raw).blockers;
        expect(b).toMatchObject({ kind: 'unknown', signature: 'flux_capacitor', message: 'a kind a newer hub knows' });
        expect(typeof b.title).toBe('string');
        expect(blockerKindOf('quantum_flux')).toBe('unknown');
        expect(blockerKindOf(undefined)).toBe('unknown');
        expect(blockerKindOf('missing_env')).toBe('missing_env');
    });

    it('keeps everything a caller reads today: held, cell, capacity, alias, bundle, phases', () => {
        const raw: Blocked = {
            status: 'blocked',
            blockers: [{ kind: 'resources', signature: 'no_capacity', message: 'full', alias: 'api', phases: { fetchMs: 3 } as never }],
            held: { claimId: 'c1', cellId: 'cell-a', hardExpiresAt: '2026-11-16T00:00:00.000Z' },
            cellId: 'cell-a',
            buildStateEvictedAt: '2026-11-15T00:00:00.000Z',
            capacity: { cellId: 'cell-a', needMb: 2048, freeMb: 512, ahead: 1 },
        };
        const typed = typedBlocked(raw);
        expect(typed).toMatchObject({ ...raw, blockers: [raw.blockers[0]] });
        expect(isCapacityWait(typed)).toBe(true);
    });

    it('is the same object shape when typed twice (the hub and the worker both pass it)', () => {
        const raw: Blocked = { status: 'blocked', blockers: [{ kind: 'toolchain', signature: 'node_version', message: 'engine "node" is incompatible' }] };
        expect(typedBlocked(typedBlocked(raw))).toEqual(typedBlocked(raw));
    });
});
