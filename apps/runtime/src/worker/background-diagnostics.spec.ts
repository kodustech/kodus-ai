import type { WorkerConfig } from '../shared/config';
import { FileEvidenceStore } from '../shared/evidence/file-evidence-store';
import { RuntimeEvidenceService } from './evidence/evidence.service';
import { EnvSessionListener } from './env-session/env-session.listener';
import { startEnvSessionServer } from './env-session/env-session-server';

jest.mock('./env-session/env-session-server', () => ({
    startEnvSessionServer: jest.fn(async () => ({
        close: (done: () => void) => done(),
    })),
}));

describe('background diagnostics do not interpolate exceptions (#2487)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());
    const failure = () =>
        Object.assign(new Error('synthetic-credential-marker'), {
            code: 'EACCES',
        });

    it('records a fixed evidence retention failure event', async () => {
        const files = Object.create(FileEvidenceStore.prototype);
        files.sweep = jest.fn(async () => {
            throw failure();
        });
        const service = new RuntimeEvidenceService({}, files);
        const warn = jest.fn();
        (service as any).logger = { warn, log: jest.fn() };
        await service.onModuleInit();
        await Promise.resolve();
        await Promise.resolve();
        const record = warn.mock.calls.find(
            ([value]) => typeof value === 'object',
        )?.[0];
        expect(record).toMatchObject({
            msg: 'evidence.sweep_failed',
            error: { kind: 'permission_denied', code: 'EACCES' },
        });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(
            'synthetic-credential-marker',
        );
        await service.onApplicationShutdown();
    });

    it('records a fixed env session sweep event', async () => {
        const sessions = {
            sweep: jest.fn(async () => {
                throw failure();
            }),
        };
        const config: Pick<WorkerConfig, 'envSessionPort' | 'secretSealKey'> = {
            envSessionPort: 12345,
            secretSealKey: Buffer.alloc(32, 1),
        };
        const listener = new EnvSessionListener(config, sessions as any);
        const warn = jest.fn();
        (listener as any).logger = { warn, log: jest.fn() };
        await listener.onModuleInit();
        expect(startEnvSessionServer).toHaveBeenCalled();
        jest.advanceTimersByTime(60000);
        await Promise.resolve();
        await Promise.resolve();
        expect(warn).toHaveBeenCalledWith({
            msg: 'env_session.sweep_failed',
            error: { kind: 'permission_denied', code: 'EACCES' },
        });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(
            'synthetic-credential-marker',
        );
        await listener.onApplicationShutdown();
    });
});
