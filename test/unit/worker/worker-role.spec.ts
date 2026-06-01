describe('resolveWorkerRole', () => {
    const ORIGINAL_ENV = process.env.WORKER_ROLE;

    afterEach(() => {
        if (ORIGINAL_ENV === undefined) {
            delete process.env.WORKER_ROLE;
        } else {
            process.env.WORKER_ROLE = ORIGINAL_ENV;
        }
        jest.resetModules();
    });

    async function load() {
        return await import('../../../apps/worker/src/worker-role');
    }

    it('returns "code-review" when WORKER_ROLE=code-review', async () => {
        process.env.WORKER_ROLE = 'code-review';
        const { resolveWorkerRole } = await load();
        expect(resolveWorkerRole()).toBe('code-review');
    });

    it('returns "analytics" when WORKER_ROLE=analytics', async () => {
        process.env.WORKER_ROLE = 'analytics';
        const { resolveWorkerRole } = await load();
        expect(resolveWorkerRole()).toBe('analytics');
    });

    it('is case-insensitive', async () => {
        process.env.WORKER_ROLE = 'ANALYTICS';
        const { resolveWorkerRole } = await load();
        expect(resolveWorkerRole()).toBe('analytics');
    });

    it('throws when WORKER_ROLE is unset', async () => {
        delete process.env.WORKER_ROLE;
        const { resolveWorkerRole } = await load();
        expect(() => resolveWorkerRole()).toThrow(/WORKER_ROLE must be set/);
    });

    it('throws when WORKER_ROLE is an unknown value', async () => {
        process.env.WORKER_ROLE = 'cron-runner';
        const { resolveWorkerRole } = await load();
        expect(() => resolveWorkerRole()).toThrow(/cron-runner/);
    });

    it('throws when WORKER_ROLE is empty string', async () => {
        process.env.WORKER_ROLE = '';
        const { resolveWorkerRole } = await load();
        // Empty string isn't undefined; the validator must still reject
        // it explicitly so a misconfigured compose `${VAR:-}` fails fast
        // instead of booting into "code-review" by accident.
        expect(() => resolveWorkerRole()).toThrow(/WORKER_ROLE must be set/);
    });
});
