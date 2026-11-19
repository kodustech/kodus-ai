import { KodusCreditsSweepCronProvider } from '../kodusCreditsSweep.cron';

describe('KodusCreditsSweepCronProvider', () => {
    it('holds the sweep lock longer than the schedule, so a slow run is not overlapped', async () => {
        const release = jest.fn().mockResolvedValue(undefined);
        const lockService = {
            acquire: jest.fn().mockResolvedValue({ release }),
        };
        const metering = {
            listOrganizationsWithKodusCredential: jest
                .fn()
                .mockResolvedValue([]),
            sweepOrganization: jest.fn(),
        };
        const cron = new KodusCreditsSweepCronProvider(
            metering as any,
            lockService as any,
        );

        await cron.handleCron();

        const [key, options] = lockService.acquire.mock.calls[0];
        expect(key).toBe('CRON:KODUS_CREDITS:SWEEP');
        // Longer than a run's 4-minute budget plus the sweeps it started,
        // short enough that a hung run holds it for two ticks at most.
        expect(options.ttl).toBeGreaterThan(5 * 60 * 1000);
        expect(options.ttl).toBeLessThanOrEqual(10 * 60 * 1000);
    });

    it('starts no organization past its 4-minute budget, leaving the rest to the next tick', async () => {
        let now = Date.parse('2026-11-19T00:00:00Z');
        const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
        const metering = {
            listOrganizationsWithKodusCredential: jest
                .fn()
                .mockResolvedValue(['o1', 'o2', 'o3', 'o4', 'o5', 'o6']),
            sweepOrganization: jest.fn(async (_organizationId: string) => {
                // Each sweep takes a minute.
                now += 60 * 1000;
                return { debited: 1, debitedUsd: 0.01 };
            }),
        };
        const cron = new KodusCreditsSweepCronProvider(
            metering as any,
            {
                acquire: jest.fn().mockResolvedValue({
                    release: jest.fn().mockResolvedValue(undefined),
                }),
            } as any,
        );

        const log = jest
            .spyOn((cron as any).logger, 'log')
            .mockImplementation(() => {});

        await cron.handleCron();
        clock.mockRestore();

        // The run reports what it swept and what it left for the next tick.
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'Kodus credits sweep completed',
                metadata: expect.objectContaining({
                    orgs: 6,
                    deferred: 2,
                    failed: 0,
                    debited: 4,
                    debitedUsd: 0.04,
                }),
            }),
        );

        // The first four start at once and end at minute 4; the budget is
        // spent, so o5 and o6 wait for the next tick.
        expect(metering.sweepOrganization.mock.calls.map(([o]) => o)).toEqual([
            'o1',
            'o2',
            'o3',
            'o4',
        ]);
    });

    it('sweeps at most four organizations at a time', async () => {
        const pending: Array<() => void> = [];
        const metering = {
            listOrganizationsWithKodusCredential: jest
                .fn()
                .mockResolvedValue(['o1', 'o2', 'o3', 'o4', 'o5', 'o6']),
            sweepOrganization: jest.fn(
                () => new Promise((r) => pending.push(() => r({ debited: 0 }))),
            ),
        };
        const cron = new KodusCreditsSweepCronProvider(
            metering as any,
            {
                acquire: jest.fn().mockResolvedValue({
                    release: jest.fn().mockResolvedValue(undefined),
                }),
            } as any,
        );
        const flush = () => new Promise((r) => setImmediate(r));

        const run = cron.handleCron();
        await flush();
        expect(metering.sweepOrganization).toHaveBeenCalledTimes(4);
        while (pending.length) {
            pending.shift()!();
            await flush();
        }
        await run;
        expect(metering.sweepOrganization).toHaveBeenCalledTimes(6);
    });

    it('reports a failed organization apart, sums the rest, and releases the lock', async () => {
        const release = jest.fn().mockResolvedValue(undefined);
        const metering = {
            listOrganizationsWithKodusCredential: jest
                .fn()
                .mockResolvedValue(['o1', 'o2', 'o3']),
            sweepOrganization: jest.fn(async (organizationId: string) => {
                if (organizationId === 'o2') throw new Error('billing down');
                return { debited: 2, debitedUsd: 0.5 };
            }),
        };
        const cron = new KodusCreditsSweepCronProvider(
            metering as any,
            { acquire: jest.fn().mockResolvedValue({ release }) } as any,
        );
        const log = jest
            .spyOn((cron as any).logger, 'log')
            .mockImplementation(() => {});
        const error = jest
            .spyOn((cron as any).logger, 'error')
            .mockImplementation(() => {});

        await cron.handleCron();

        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    orgs: 3,
                    deferred: 0,
                    failed: 1,
                    debited: 4,
                    debitedUsd: 1,
                }),
            }),
        );
        expect(error).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'Some Kodus credits sweeps failed',
                metadata: { failed: 1, total: 3 },
            }),
        );
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('sweeps nothing when another worker holds the lock', async () => {
        const metering = {
            listOrganizationsWithKodusCredential: jest.fn(),
            sweepOrganization: jest.fn(),
        };
        const cron = new KodusCreditsSweepCronProvider(
            metering as any,
            { acquire: jest.fn().mockResolvedValue(null) } as any,
        );

        await cron.handleCron();

        expect(
            metering.listOrganizationsWithKodusCredential,
        ).not.toHaveBeenCalled();
    });
});
