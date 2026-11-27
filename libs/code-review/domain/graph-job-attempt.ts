export interface GraphJobAttempt {
    jobId: string;
    attemptId: string;
}

export class StaleGraphJobError extends Error {
    constructor(jobId: string) {
        super(`Graph job ${jobId} is no longer processing this attempt`);
    }
}
