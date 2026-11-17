import { CronRunGate } from './cron-run-gate';

/**
 * A cron run that outlives shutdown kept querying after TypeORM closed its
 * connection: 279 "Driver not Connected" errors from one API task during the
 * 2026-11-17 deploy.
 */
describe('CronRunGate', () => {
    it('lets the run in progress finish before shutdown goes on, and tells it to stop picking up work', async () => {
        const gate = new CronRunGate();
        let release!: () => void;
        const finished: string[] = [];

        const run = gate.run(async () => {
            await new Promise<void>((r) => (release = r));
            finished.push(gate.stopping ? 'saw stop' : 'no stop');
        });

        const stopped = gate.stop(1_000).then(() => finished.push('stopped'));
        release();
        await Promise.all([run, stopped]);

        expect(finished).toEqual(['saw stop', 'stopped']);
    });

    it('does not hold shutdown longer than its budget', async () => {
        const gate = new CronRunGate();
        void gate.run(() => new Promise<void>(() => undefined));

        const started = Date.now();
        await gate.stop(50);

        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('starts no run once shutdown began', async () => {
        const gate = new CronRunGate();
        await gate.stop(10);
        const work = jest.fn(async () => undefined);

        await gate.run(work);

        expect(work).not.toHaveBeenCalled();
    });
});
