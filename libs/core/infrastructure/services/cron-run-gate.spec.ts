import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { CronRunGate, gatedCron } from './cron-run-gate';

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
        const elapsed = Date.now() - started;

        expect(elapsed).toBeGreaterThanOrEqual(45);
        expect(elapsed).toBeLessThan(300);
    });

    it('reports how many runs were still going when the budget ran out', async () => {
        const gate = new CronRunGate();
        void gate.run(() => new Promise<void>(() => undefined));

        await expect(gate.stop(10)).resolves.toBe(1);
    });

    it('waits for an older run still going when a newer tick started', async () => {
        const gate = new CronRunGate();
        let releaseOlder!: () => void;
        let stopped = false;

        void gate.run(() => new Promise<void>((r) => (releaseOlder = r)));
        void gate.run(async () => undefined);

        const stopping = gate.stop(1_000).then(() => (stopped = true));
        await new Promise((r) => setTimeout(r, 20));
        expect(stopped).toBe(false);

        releaseOlder();
        await stopping;
        expect(stopped).toBe(true);
    });

    it('starts no run once shutdown began', async () => {
        const gate = new CronRunGate();
        await gate.stop(10);
        const work = jest.fn(async () => undefined);

        await gate.run(work);

        expect(work).not.toHaveBeenCalled();
    });

    describe('gatedCron', () => {
        const scheduled = (gate: CronRunGate, work: jest.Mock) => {
            class Job {
                @gatedCron(gate, '*/5 * * * *', { name: 'job' })
                async tick() {
                    return work(this);
                }
            }
            return new Job();
        };

        it('keeps the schedule Nest reads, on the function Nest calls', () => {
            const job = scheduled(new CronRunGate(), jest.fn());

            expect(
                Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', job.tick),
            ).toEqual(expect.objectContaining({ cronTime: '*/5 * * * *' }));
            expect(Reflect.getMetadata('SCHEDULER_NAME', job.tick)).toBe('job');
        });

        it('runs the method on its instance until shutdown, then not at all', async () => {
            const gate = new CronRunGate();
            const work = jest.fn();
            const job = scheduled(gate, work);

            await job.tick();
            await gate.stop(10);
            await job.tick();

            expect(work).toHaveBeenCalledTimes(1);
            expect(work).toHaveBeenCalledWith(job);
        });

        it('makes shutdown wait for a scheduled run in progress', async () => {
            const gate = new CronRunGate();
            let release!: () => void;
            const job = scheduled(
                gate,
                jest.fn(() => new Promise<void>((r) => (release = r))),
            );
            let stopped = false;

            void job.tick();
            const stopping = gate.stop(1_000).then(() => (stopped = true));
            await new Promise((r) => setTimeout(r, 20));
            expect(stopped).toBe(false);

            release();
            await stopping;
        });
    });

    it('makes a second stop wait for the first, not for a budget of its own', async () => {
        // Nest awaits beforeApplicationShutdown module by module, so a second
        // hook calls stop after the first one returned.
        const gate = new CronRunGate();
        void gate.run(() => new Promise<void>(() => undefined));

        await expect(gate.stop(50)).resolves.toBe(1);
        const started = Date.now();
        await expect(gate.stop(50)).resolves.toBe(1);

        expect(Date.now() - started).toBeLessThan(20);
    });

    it('has its shutdown hook provided by exactly one module', () => {
        // Every app imports NotificationModule; a second provider holds
        // shutdown for its own budget again.
        const root = join(__dirname, '../../../..');
        const providers: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                if (name === 'node_modules' || name.startsWith('.')) continue;
                const path = join(dir, name);
                if (statSync(path).isDirectory()) {
                    walk(path);
                } else if (
                    path.endsWith('.module.ts') &&
                    /^\s*CronShutdownService,/m.test(readFileSync(path, 'utf8'))
                ) {
                    providers.push(path.slice(root.length + 1));
                }
            }
        };
        walk(join(root, 'apps'));
        walk(join(root, 'libs'));

        expect(providers).toEqual([
            'libs/notifications/modules/notification.module.ts',
        ]);
    });

    it('is the only way the repository schedules a cron', () => {
        // A bare @Cron outlives the database on shutdown (#2589, row 11).
        const root = join(__dirname, '../../../..');
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                if (name === 'node_modules' || name.startsWith('.')) continue;
                const path = join(dir, name);
                if (statSync(path).isDirectory()) {
                    walk(path);
                } else if (
                    path.endsWith('.ts') &&
                    !path.endsWith('.spec.ts') &&
                    // A decorator at the start of a line, not a mention in
                    // a comment or a string.
                    /^\s*@Cron\(/m.test(readFileSync(path, 'utf8'))
                ) {
                    offenders.push(path.slice(root.length + 1));
                }
            }
        };
        walk(join(root, 'apps'));
        walk(join(root, 'libs'));

        expect(offenders).toEqual([]);
    });
});
