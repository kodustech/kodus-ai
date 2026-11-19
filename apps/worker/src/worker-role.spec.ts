import { resolveWorkerRole } from './worker-role';

describe('resolveWorkerRole', () => {
    const original = process.env.WORKER_ROLE;
    afterEach(() => {
        process.env.WORKER_ROLE = original;
    });

    it.each(['code-review', 'analytics', 'security-scan'])(
        'accepts %s',
        (role) => {
            process.env.WORKER_ROLE = role.toUpperCase();
            expect(resolveWorkerRole()).toBe(role);
        },
    );

    it('refuses an unknown role', () => {
        process.env.WORKER_ROLE = 'scanner';
        expect(() => resolveWorkerRole()).toThrow(/security-scan/);
    });
});
