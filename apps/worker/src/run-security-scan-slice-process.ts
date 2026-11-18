import { createLogger } from '@libs/core/log/logger';
import {
    isSlicePreemptedError,
    SlicePreemptedError,
} from '@libs/core/workflow/domain/errors/slice-preempted.error';
import {
    IJobProcessorService,
    JOB_PROCESSOR_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import { SECURITY_SCAN_SLICE_EXIT_PREEMPTED } from '@libs/core/workflow/infrastructure/security-scan-runtime';

const logger = createLogger('SecurityScanSliceProcess');

export type SliceAppContext = {
    get<T>(token: unknown): T;
    close(): Promise<void>;
};

type SliceProcess = {
    once(event: string, listener: () => void): void;
    removeListener(event: string, listener: () => void): void;
};

/**
 * Child entry: run one slice, then close Nest. SIGTERM aborts the
 * processor with SlicePreemptedError so it can release the sandbox and
 * leave the scan RUNNING. Returns the process exit code.
 */
export async function runSecurityScanSliceProcess(
    appContext: SliceAppContext,
    jobId: string,
    options?: {
        abort?: AbortController;
        process?: SliceProcess;
        onError?: (error: Error) => void;
    },
): Promise<number> {
    const abort = options?.abort ?? new AbortController();
    const proc = options?.process ?? process;
    const onStop = () => abort.abort(new SlicePreemptedError());
    proc.once('SIGTERM', onStop);
    proc.once('SIGINT', onStop);
    try {
        const processor = appContext.get<IJobProcessorService>(
            JOB_PROCESSOR_SERVICE_TOKEN,
        );
        await processor.process(jobId, abort.signal);
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        options?.onError?.(err);
        await closeQuietly(appContext, jobId);
        return isSlicePreemptedError(err)
            ? SECURITY_SCAN_SLICE_EXIT_PREEMPTED
            : 1;
    } finally {
        proc.removeListener('SIGTERM', onStop);
        proc.removeListener('SIGINT', onStop);
    }

    await closeQuietly(appContext, jobId);
    return 0;
}

async function closeQuietly(
    appContext: SliceAppContext,
    jobId: string,
): Promise<void> {
    try {
        await appContext.close();
    } catch (error) {
        logger.error({
            message: 'Security-scan slice child failed to close Nest',
            context: 'SecurityScanSliceProcess',
            error,
            metadata: { jobId },
        });
    }
}
