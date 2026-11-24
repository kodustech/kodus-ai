import { MACHINE_QUEUE_POLL_MS, queueRegistrations } from './queue-limits';

const names = { execution: 'runtime-executions', admission: 'runtime-admissions', finalize: 'runtime-admission-finalizers', runs: 'runtime-runs', setups: 'runtime-setups' };

describe('queueRegistrations', () => {
    it('limits each replica and holds setups to their own global limit', () => {
        const q = Object.fromEntries(queueRegistrations({ globalConcurrency: 20, partitionConcurrency: 2, setupPerOrg: 2, setupConcurrency: 4, workerConcurrency: 10 }, names));
        expect(q['runtime-runs']).toEqual({ globalConcurrency: 20, partitionConcurrency: 2, workerConcurrency: 10, minPollingIntervalMs: MACHINE_QUEUE_POLL_MS, onConflict: 'always_update' });
        expect(q['runtime-setups']).toEqual({ globalConcurrency: 4, partitionConcurrency: 2, workerConcurrency: 4, minPollingIntervalMs: MACHINE_QUEUE_POLL_MS, onConflict: 'always_update' });
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
        expect(q['runtime-executions']).toEqual({ globalConcurrency: 20, partitionConcurrency: 2, workerConcurrency: 6, minPollingIntervalMs: MACHINE_QUEUE_POLL_MS, onConflict: 'always_update' });
        expect(q['runtime-admissions']).not.toHaveProperty('workerConcurrency');
    });

    it('keeps the old shape where a setting is absent', () => {
        const q = Object.fromEntries(queueRegistrations({ globalConcurrency: 2, partitionConcurrency: 2 }, names));
        expect(q['runtime-runs']).toEqual({ globalConcurrency: 2, partitionConcurrency: 2, minPollingIntervalMs: MACHINE_QUEUE_POLL_MS, onConflict: 'always_update' });
        expect(q['runtime-setups']).toEqual({ globalConcurrency: 2, minPollingIntervalMs: MACHINE_QUEUE_POLL_MS, onConflict: 'always_update' });
    });

    // P17: a partitioned queue is swept one partition per poll on every replica (DBOS wfqueue.js), a SERIALIZABLE
    // transaction each, even when the global limit is full: 101 transactions/s at DBOS's 1 s with 100 orgs queued
    // on one replica, 28 at 5 s. A Run lasts minutes, so a few seconds more to start is nothing.
    it('polls the queues of machine work every 5 s, and leaves the short admission attempts at the default', () => {
        expect(MACHINE_QUEUE_POLL_MS).toBe(5_000);
        const admission = { globalExecuting: 20, perOrgExecuting: 2, attemptConcurrency: 8, attemptPerOrg: 1 };
        const q = Object.fromEntries(queueRegistrations({ globalConcurrency: 20, partitionConcurrency: 2, durableAdmission: true, admission }, names));
        expect(q['runtime-admissions']).not.toHaveProperty('minPollingIntervalMs');
        expect(q['runtime-admission-finalizers']).not.toHaveProperty('minPollingIntervalMs');
    });

    // A suite lasts tens of minutes on several hosts: its own queue, so it never takes a Run's slot or a setup's.
    it('gives the suites a queue of their own with a per-org and a global limit, in both admission modes', () => {
        const withSuites = { ...names, suites: 'runtime-suites' };
        const settings = { globalConcurrency: 20, partitionConcurrency: 2, suitePerOrg: 3, suiteConcurrency: 5, workerConcurrency: 10 };
        const q = Object.fromEntries(queueRegistrations(settings, withSuites));
        expect(q['runtime-suites']).toEqual({ globalConcurrency: 5, partitionConcurrency: 3, workerConcurrency: 5, minPollingIntervalMs: MACHINE_QUEUE_POLL_MS, onConflict: 'always_update' });
        const admission = { globalExecuting: 20, perOrgExecuting: 2, attemptConcurrency: 8, attemptPerOrg: 1 };
        const durable = Object.fromEntries(queueRegistrations({ ...settings, durableAdmission: true, admission }, withSuites));
        expect(durable['runtime-suites']).toEqual(q['runtime-suites']);
        // Without the names or the limits, no suite queue exists.
        expect(Object.keys(Object.fromEntries(queueRegistrations(settings, names)))).not.toContain('runtime-suites');
    });
});
