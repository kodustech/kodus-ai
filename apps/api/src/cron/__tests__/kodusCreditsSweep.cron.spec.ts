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
        // Every 5 minutes; the lock outlasts several of them.
        expect(options.ttl).toBeGreaterThanOrEqual(30 * 60 * 1000);
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
});
