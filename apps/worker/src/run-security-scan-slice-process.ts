import { SlicePreemptedError } from '@libs/core/workflow/domain/errors/slice-preempted.error';
import {
    IJobProcessorService,
    JOB_PROCESSOR_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-processor.service.contract';

type SliceAppContext = {
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
    const processor = appContext.get<IJobProcessorService>(
        JOB_PROCESSOR_SERVICE_TOKEN,
    );
    const onStop = () => abort.abort(new SlicePreemptedError());
    proc.once('SIGTERM', onStop);
    proc.once('SIGINT', onStop);
    try {
        await processor.process(jobId, abort.signal);
        await appContext.close();
        return 0;
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        options?.onError?.(err);
        try {
            await appContext.close();
        } catch {
            // exit below
        }
        return 1;
    } finally {
        proc.removeListener('SIGTERM', onStop);
        proc.removeListener('SIGINT', onStop);
    }
}
