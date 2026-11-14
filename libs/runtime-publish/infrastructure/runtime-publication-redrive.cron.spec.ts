import { RuntimePublicationRedriveCron } from './runtime-publication-redrive.cron';

const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@libs/core/log/logger', () => ({ createLogger: () => logger }));

beforeEach(() => jest.clearAllMocks());

describe('RuntimePublicationRedriveCron', () => {
    it('never runs two sweeps at once on a replica', async () => {
        let finish!: () => void;
        const sweep = jest.fn(() => new Promise((resolve) => (finish = () => resolve({ stuck: 0, redriven: 0, recovered: 0, gaveUp: 0 }))));
        const cron = new RuntimePublicationRedriveCron({ sweep } as any);

        const first = cron.handleCron();
        await cron.handleCron();
        finish();
        await first;
        expect(sweep).toHaveBeenCalledTimes(1);

        sweep.mockResolvedValueOnce({ stuck: 0, redriven: 0, recovered: 0, gaveUp: 0 } as never);
        await cron.handleCron();
        expect(sweep).toHaveBeenCalledTimes(2);
    });

    it('a failed sweep is logged and the next tick runs', async () => {
        const sweep = jest.fn().mockRejectedValueOnce(new Error('mongo down')).mockResolvedValueOnce({ stuck: 1, redriven: 1, recovered: 1, gaveUp: 0 });
        const cron = new RuntimePublicationRedriveCron({ sweep } as any);
        await cron.handleCron();
        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Runtime publication redrive: sweep failed' }));
        await cron.handleCron();
        expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({ metadata: { stuck: 1, redriven: 1, recovered: 1, gaveUp: 0 } }));
    });
});
