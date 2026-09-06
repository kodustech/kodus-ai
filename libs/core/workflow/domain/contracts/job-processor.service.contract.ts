import type { WorkflowEphemeralPayload } from '../types/workflow-ephemeral-payload';

export const JOB_PROCESSOR_SERVICE_TOKEN = Symbol.for('JobProcessorService');

export interface IJobProcessorService {
    process(
        jobId: string,
        signal?: AbortSignal,
        ephemeralPayload?: WorkflowEphemeralPayload,
    ): Promise<void>;

    handleFailure(jobId: string, error: Error): Promise<void>;

    markCompleted(jobId: string, result?: unknown): Promise<void>;
}
