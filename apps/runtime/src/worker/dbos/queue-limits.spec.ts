import { queueRegistrations } from './queue-limits';

const names = { execution: 'runtime-executions', admission: 'runtime-admissions', finalize: 'runtime-admission-finalizers', runs: 'runtime-runs', setups: 'runtime-setups' };

describe('queueRegistrations', () => {
    it('limits each replica and holds setups to their own global limit', () => {
        const q = Object.fromEntries(queueRegistrations({ globalConcurrency: 20, partitionConcurrency: 2, setupPerOrg: 2, setupConcurrency: 4, workerConcurrency: 10 }, names));
        expect(q['runtime-runs']).toEqual({ globalConcurrency: 20, partitionConcurrency: 2, workerConcurrency: 10, onConflict: 'always_update' });
        expect(q['runtime-setups']).toEqual({ globalConcurrency: 4, partitionConcurrency: 2, workerConcurrency: 4, onConflict: 'always_update' });
    });

    // DBOS refuses a partition or replica limit above the queue's global one, which failed the launch.
    it('never names a partition or replica limit above its queue global limit', () => {
        const q = Object.fromEntries(queueRegistrations({ globalConcurrency: 1, partitionConcurrency: 2, setupPerOrg: 8, setupConcurrency: 6, workerConcurrency: 10 }, names));
        for (const o of Object.values(q)) {
            expect(o.partitionConcurrency).toBeLessThanOrEqual(o.globalConcurrency!);
            expect(o.workerConcurrency).toBeLessThanOrEqual(o.globalConcurrency!);
        }
        expect(q['runtime-setups'].globalConcurrency).toBe(1);
    });

    it('sizes the executions queue from admission and leaves short attempts per replica unlimited', () => {
        const admission = { globalExecuting: 20, perOrgExecuting: 2, attemptConcurrency: 8, attemptPerOrg: 1 };
        const q = Object.fromEntries(queueRegistrations({ globalConcurrency: 20, partitionConcurrency: 2, workerConcurrency: 6, durableAdmission: true, admission }, names));
        expect(Object.keys(q)).toEqual(['runtime-executions', 'runtime-admissions', 'runtime-admission-finalizers']);
        expect(q['runtime-executions']).toEqual({ globalConcurrency: 20, partitionConcurrency: 2, workerConcurrency: 6, onConflict: 'always_update' });
        expect(q['runtime-admissions']).not.toHaveProperty('workerConcurrency');
    });

    it('keeps the old shape where a setting is absent', () => {
        const q = Object.fromEntries(queueRegistrations({ globalConcurrency: 2, partitionConcurrency: 2 }, names));
        expect(q['runtime-runs']).toEqual({ globalConcurrency: 2, partitionConcurrency: 2, onConflict: 'always_update' });
        expect(q['runtime-setups']).toEqual({ globalConcurrency: 2, onConflict: 'always_update' });
    });
});
