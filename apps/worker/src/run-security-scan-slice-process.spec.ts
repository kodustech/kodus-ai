import { EventEmitter } from 'events';

import { JOB_PROCESSOR_SERVICE_TOKEN } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import {
    isSlicePreemptedError,
    SlicePreemptedError,
} from '@libs/core/workflow/domain/errors/slice-preempted.error';

import { SECURITY_SCAN_SLICE_EXIT_PREEMPTED } from '@libs/core/workflow/infrastructure/security-scan-runtime';

import { runSecurityScanSliceProcess } from './run-security-scan-slice-process';

describe('runSecurityScanSliceProcess', () => {
    it('returns 0 when the processor finishes', async () => {
        const processor = { process: jest.fn().mockResolvedValue(undefined) };
        const appContext = {
            get: jest.fn((token) => {
                expect(token).toBe(JOB_PROCESSOR_SERVICE_TOKEN);
                return processor;
            }),
            close: jest.fn().mockResolvedValue(undefined),
        };

        await expect(
            runSecurityScanSliceProcess(appContext, 'job-1'),
        ).resolves.toBe(0);
        expect(processor.process).toHaveBeenCalledWith(
            'job-1',
            expect.any(AbortSignal),
        );
        expect(appContext.close).toHaveBeenCalled();
    });

    it('aborts the processor on SIGTERM and returns the preempted exit after close', async () => {
        const processor = {
            process: jest.fn(
                (_jobId: string, signal: AbortSignal) =>
                    new Promise<void>((_resolve, reject) => {
                        signal.addEventListener('abort', () => {
                            reject(
                                isSlicePreemptedError(signal.reason)
                                    ? signal.reason
                                    : new Error('aborted'),
                            );
                        });
                    }),
            ),
        };
        const appContext = {
            get: jest.fn(() => processor),
            close: jest.fn().mockResolvedValue(undefined),
        };
        const fakeProcess = new EventEmitter();
        const onError = jest.fn();

        const done = runSecurityScanSliceProcess(appContext, 'job-1', {
            process: fakeProcess,
            onError,
        });
        fakeProcess.emit('SIGTERM');
        await expect(done).resolves.toBe(SECURITY_SCAN_SLICE_EXIT_PREEMPTED);
        expect(onError).toHaveBeenCalledWith(expect.any(SlicePreemptedError));
        expect(appContext.close).toHaveBeenCalled();
    });

    it('returns 1 after close when resolving the processor throws', async () => {
        const appContext = {
            get: jest.fn(() => {
                throw new Error('no processor');
            }),
            close: jest.fn().mockResolvedValue(undefined),
        };

        await expect(
            runSecurityScanSliceProcess(appContext, 'job-1'),
        ).resolves.toBe(1);
        expect(appContext.close).toHaveBeenCalled();
    });
});
