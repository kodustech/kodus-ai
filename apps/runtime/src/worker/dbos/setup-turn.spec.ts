import { setupTurn, type SetupWorkflowLite } from './setup-turn';

const w = (id: string, createdAt: number, status: string): SetupWorkflowLite => ({ workflowID: `setup:env-1:${id}`, createdAt, status });
const me = w('b', 200, 'PENDING');

describe('setupTurn: one setup of an environment builds at a time, and the newest one wins', () => {
    it('waits while an earlier setup of the environment is running', () => {
        expect(setupTurn(me, [w('a', 100, 'PENDING')])).toBe('wait');
    });

    it('builds when the only other setups are earlier ones that ended or are still queued', () => {
        expect(setupTurn(me, [w('a', 100, 'SUCCESS'), w('0', 50, 'ERROR'), w('c', 150, 'ENQUEUED')])).toBe('go');
    });

    it('is superseded, and builds nothing, when a newer setup already runs: the older one would land last', () => {
        expect(setupTurn(w('a', 100, 'PENDING'), [w('b', 200, 'PENDING')])).toBe('superseded');
    });

    it('is superseded when a newer setup already ended', () => {
        expect(setupTurn(w('a', 100, 'PENDING'), [w('b', 200, 'SUCCESS')])).toBe('superseded');
    });

    it('queues a newer setup that is only waiting for its slot behind this one instead of superseding it', () => {
        expect(setupTurn(w('a', 100, 'PENDING'), [w('b', 200, 'ENQUEUED')])).toBe('go');
    });

    it('is not superseded by a newer setup that failed or was cancelled', () => {
        expect(setupTurn(w('a', 100, 'PENDING'), [w('b', 200, 'ERROR'), w('c', 300, 'CANCELLED')])).toBe('go');
    });

    it('waits for the earlier running setup first, even when a newer one runs too', () => {
        expect(setupTurn(w('b', 200, 'PENDING'), [w('a', 100, 'PENDING'), w('c', 300, 'PENDING')])).toBe('wait');
    });

    it('breaks a tie on the creation time by workflow id, and never counts itself or an admission rejection', () => {
        expect(setupTurn(w('b', 100, 'PENDING'), [w('a', 100, 'PENDING')])).toBe('wait');
        expect(setupTurn(w('a', 100, 'PENDING'), [w('a', 100, 'PENDING'), { ...w('z', 300, 'SUCCESS'), workflowID: 'setup:env-1:z:admission-rejected' }])).toBe('go');
    });
});
