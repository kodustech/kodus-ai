export const EPHEMERAL_JOB_TERMINAL_MESSAGE =
    'Review context could not be processed. Submit the review again.';

export class EphemeralJobReconciliationError extends Error {
    constructor(readonly jobId: string) {
        super(`Could not reconcile ephemeral workflow job ${jobId}`);
        this.name = EphemeralJobReconciliationError.name;
    }
}
