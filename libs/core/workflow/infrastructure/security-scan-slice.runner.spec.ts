import { EventEmitter } from 'events';

import {
    runSecurityScanSliceChild,
    type SpawnSliceChild,
} from './security-scan-slice.runner';
import { SECURITY_SCAN_SLICE_JOB_ID_ENV } from './security-scan-runtime';

class FakeChild extends EventEmitter {
    killed = false;
    exitCode: number | null = null;
    kill = jest.fn((signal?: string) => {
        this.killed = true;
        this.exitCode = signal === 'SIGKILL' ? null : 1;
        this.emit('exit', this.exitCode, signal ?? 'SIGTERM');
        return true;
    });
}

describe('runSecurityScanSliceChild', () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllTimers();
    });

    it('spawns the worker entry with the slice job id and no inspect args', async () => {
        const child = new FakeChild();
        const spawn = jest.fn(
            () => child as unknown as ReturnType<SpawnSliceChild>,
        );

        const done = runSecurityScanSliceChild('job-1', {
            spawn,
            env: { FOO: 'bar' },
            execPath: '/usr/bin/node',
            scriptPath: '/app/dist/apps/worker/main.js',
        });

        expect(spawn).toHaveBeenCalledWith(
            '/usr/bin/node',
            ['/app/dist/apps/worker/main.js'],
            expect.objectContaining({
                stdio: 'inherit',
                env: expect.objectContaining({
                    FOO: 'bar',
                    [SECURITY_SCAN_SLICE_JOB_ID_ENV]: 'job-1',
                }),
            }),
        );

        child.emit('exit', 0, null);
        await done;
    });

    it('rejects when the child exits non-zero', async () => {
        const child = new FakeChild();
        const spawn = jest.fn(
            () => child as unknown as ReturnType<SpawnSliceChild>,
        );

        const done = runSecurityScanSliceChild('job-1', {
            spawn,
            scriptPath: '/app/main.js',
            execPath: '/usr/bin/node',
        });
        child.emit('exit', 1, null);

        await expect(done).rejects.toThrow(/exited 1/);
    });

    it('kills the child when aborted', async () => {
        const child = new FakeChild();
        const spawn = jest.fn(
            () => child as unknown as ReturnType<SpawnSliceChild>,
        );
        const abort = new AbortController();

        const done = runSecurityScanSliceChild('job-1', {
            spawn,
            abortSignal: abort.signal,
            scriptPath: '/app/main.js',
            execPath: '/usr/bin/node',
        });
        abort.abort();

        await expect(done).rejects.toThrow(/exited/);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('kills the child when the parent wait is exceeded', async () => {
        jest.useFakeTimers();
        const child = new FakeChild();
        child.kill = jest.fn(() => {
            child.killed = true;
            return true;
        });
        const spawn = jest.fn(
            () => child as unknown as ReturnType<SpawnSliceChild>,
        );

        const done = runSecurityScanSliceChild('job-1', {
            spawn,
            parentWaitMs: 1_000,
            scriptPath: '/app/main.js',
            execPath: '/usr/bin/node',
        });
        const rejected = expect(done).rejects.toThrow(/exceeded 1000ms/);
        await jest.advanceTimersByTimeAsync(1_000);
        await rejected;
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        jest.useRealTimers();
    });

    it('falls back to the default wait when parentWaitMs is 0', async () => {
        jest.useFakeTimers();
        const child = new FakeChild();
        child.kill = jest.fn(() => true);
        const spawn = jest.fn(
            () => child as unknown as ReturnType<SpawnSliceChild>,
        );

        const done = runSecurityScanSliceChild('job-1', {
            spawn,
            parentWaitMs: 0,
            scriptPath: '/app/main.js',
            execPath: '/usr/bin/node',
        });
        await jest.advanceTimersByTimeAsync(1);
        expect(child.kill).not.toHaveBeenCalled();
        child.emit('exit', 0, null);
        await done;
        jest.useRealTimers();
    });

    it('SIGKILLs a child that ignores SIGTERM', async () => {
        jest.useFakeTimers();
        const child = new FakeChild();
        child.kill = jest.fn((signal?: string) => {
            child.killed = true;
            if (signal === 'SIGKILL') {
                child.emit('exit', null, 'SIGKILL');
            }
            return true;
        });
        const spawn = jest.fn(
            () => child as unknown as ReturnType<SpawnSliceChild>,
        );
        const abort = new AbortController();

        const done = runSecurityScanSliceChild('job-1', {
            spawn,
            abortSignal: abort.signal,
            scriptPath: '/app/main.js',
            execPath: '/usr/bin/node',
        });
        const assertion = expect(done).rejects.toThrow(/exited SIGKILL/);
        abort.abort();
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
        await jest.advanceTimersByTimeAsync(5_000);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
        await assertion;
        jest.useRealTimers();
    });
});
