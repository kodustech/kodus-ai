import {
    RuntimeExternalMaintenanceCron,
    isExternalMaintenanceEnabled,
} from './maintenance.cron';

function fixture() {
    const release = jest.fn(async () => undefined);
    const acquire = jest.fn(async () => ({ release }));
    const run = jest.fn(async (..._args: unknown[]) => ({
        reconciled: 1,
        completed: 1,
        purged: 0,
        errors: 0,
        budgetStopped: false,
    }));
    const factory = jest.fn(async () => ({
        locks: { acquire },
        sweep: { run },
    }));
    return {
        release,
        acquire,
        run,
        factory,
        cron: new RuntimeExternalMaintenanceCron(factory as never, {
            enabled: true,
            budgetMs: 1000,
        }),
    };
}

it('requires an explicit maintenance opt-in', () => {
    expect(isExternalMaintenanceEnabled({})).toBe(false);
    expect(
        isExternalMaintenanceEnabled({
            RUNTIME_EXTERNAL_MAINTENANCE_ENABLED: 'false',
        }),
    ).toBe(false);
    expect(
        isExternalMaintenanceEnabled({
            RUNTIME_EXTERNAL_MAINTENANCE_ENABLED: 'true',
        }),
    ).toBe(true);
});
it('leaves the database unopened while disabled', async () => {
    const h = fixture();
    await new RuntimeExternalMaintenanceCron(h.factory as never, {
        enabled: false,
        budgetMs: 1000,
    }).handleCron();
    expect(h.factory).not.toHaveBeenCalled();
});
it('uses the cluster lock and local single-flight, releasing after failures', async () => {
    const h = fixture();
    let finish!: () => void;
    h.run.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = () =>
                    resolve({
                        reconciled: 0,
                        completed: 0,
                        purged: 0,
                        errors: 0,
                        budgetStopped: false,
                    });
            }),
    );
    const active = h.cron.handleCron();
    await Promise.resolve();
    await Promise.resolve();
    await h.cron.handleCron();
    expect(h.run).toHaveBeenCalledTimes(1);
    finish();
    await active;
    expect(h.release).toHaveBeenCalledTimes(1);
    h.run.mockRejectedValueOnce(new Error('do not log raw finding detail'));
    await h.cron.handleCron();
    expect(h.release).toHaveBeenCalledTimes(2);
});
it('does not work when another replica owns the lock', async () => {
    const h = fixture();
    h.acquire.mockResolvedValueOnce(null as never);
    await h.cron.handleCron();
    expect(h.run).not.toHaveBeenCalled();
});
it('cancels work at its budget and on shutdown, then releases its pinned lock', async () => {
    jest.useFakeTimers();
    const h = fixture();
    h.run.mockImplementationOnce(
        async (signal) =>
            new Promise((resolve) => {
                (signal as AbortSignal).addEventListener(
                    'abort',
                    () =>
                        resolve({
                            reconciled: 0,
                            completed: 0,
                            purged: 0,
                            errors: 0,
                            budgetStopped: true,
                        }),
                    { once: true },
                );
            }),
    );
    try {
        const running = h.cron.handleCron();
        await Promise.resolve();
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(501);
        await running;
        expect(h.release).toHaveBeenCalledTimes(1);
        await h.cron.onModuleDestroy();
        await h.cron.handleCron();
        expect(h.factory).toHaveBeenCalledTimes(1);
    } finally {
        jest.useRealTimers();
    }
});

it('records closed metrics for skipped and failed ticks without raw exceptions', async () => {
    const h = fixture();
    const recordTick = jest.fn();
    const cron = new RuntimeExternalMaintenanceCron(
        h.factory as never,
        { enabled: true, budgetMs: 1000 },
        { recordTick },
    );
    h.acquire.mockResolvedValueOnce(null as never);
    await cron.handleCron();
    h.run.mockRejectedValueOnce(new Error('sensitive upstream detail'));
    await cron.handleCron();
    expect(recordTick.mock.calls.map((c) => c[0])).toEqual([
        'skipped',
        'failed',
    ]);
    expect(JSON.stringify(recordTick.mock.calls)).not.toContain('sensitive');
});
it("a failed tick logs which error it was (name and code, never its message), the database's cause included", async () => {
    const h = fixture();
    const cron = new RuntimeExternalMaintenanceCron(
        h.factory as never,
        { enabled: true, budgetMs: 1000 },
        { recordTick: () => undefined },
    );
    const lines: unknown[] = [];
    jest.spyOn((cron as any).logger, 'log').mockImplementation((line: unknown) => void lines.push(line));
    const refused = Object.assign(new Error('password authentication failed for a secret user'), { code: '28P01' });
    h.factory.mockRejectedValueOnce(new Error('External maintenance database unavailable', { cause: refused }) as never);
    await cron.handleCron();

    expect(lines.at(-1)).toMatchObject({
        outcome: 'failed',
        failure: { name: 'Error', cause: { name: 'Error', code: '28P01' } },
    });
    expect(JSON.stringify(lines)).not.toContain('password');
});
