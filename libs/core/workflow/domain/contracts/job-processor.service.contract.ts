export const JOB_PROCESSOR_SERVICE_TOKEN = Symbol.for('JobProcessorService');

export interface IJobProcessorService {
    process(jobId: string, signal?: AbortSignal): Promise<void>;

    /**
     * Marks the job FAILED. A processor that needs to tell its caller whether
     * the write actually landed (a caller whose lease may have been reclaimed
     * uses that answer to stop instead of notifying the author and rethrowing,
     * #1830 review) may resolve `true`/`false`; `void` stays valid for the
     * processors that have nothing to report.
     */
    handleFailure(
        jobId: string,
        error: Error,
        options?: unknown,
    ): Promise<void | boolean>;

    markCompleted(jobId: string, result?: unknown): Promise<void>;
}
