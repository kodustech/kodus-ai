import { mongoAppName } from './mongo-app-name';

describe('mongoAppName', () => {
    const KEYS = ['COMPONENT_TYPE', 'WORKER_ROLE'];
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
        saved = {};
        for (const k of KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });
    afterEach(() => {
        for (const k of KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('names the component the process runs as', () => {
        process.env.COMPONENT_TYPE = 'webhook';
        expect(mongoAppName()).toBe('kodus-webhook');
    });

    it('tells the worker roles apart, since they share one image', () => {
        process.env.COMPONENT_TYPE = 'worker';
        process.env.WORKER_ROLE = 'analytics';
        expect(mongoAppName()).toBe('kodus-worker-analytics');
    });

    it('names a worker that has no role', () => {
        process.env.COMPONENT_TYPE = 'worker';
        delete process.env.WORKER_ROLE;
        expect(mongoAppName()).toBe('kodus-worker');
    });

    it('ignores WORKER_ROLE outside the worker', () => {
        process.env.COMPONENT_TYPE = 'api';
        process.env.WORKER_ROLE = 'code-review';
        expect(mongoAppName()).toBe('kodus-api');
    });

    it('separates a second client of the same process by its suffix', () => {
        process.env.COMPONENT_TYPE = 'api';
        expect(mongoAppName('exporter')).toBe('kodus-api-exporter');
    });

    it('still names a process that never set its component', () => {
        expect(mongoAppName('migrations')).toBe('kodus-default-migrations');
    });
});
