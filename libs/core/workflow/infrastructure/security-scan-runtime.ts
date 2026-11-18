/**
 * Deep-scan worker runtime: the parent process owns AMQP and the ECS
 * health probe; a child process runs one slice. Constants shared by the
 * consumer, the inbox claim, and the worker entry.
 */

export const SECURITY_SCAN_JOB_QUEUE = 'workflow.jobs.security_scan.queue';

/** Set on the child that runs `processor.process(jobId)`. */
export const SECURITY_SCAN_SLICE_JOB_ID_ENV = 'SECURITY_SCAN_SLICE_JOB_ID';

export function isSecurityScanSliceProcess(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    const jobId = env[SECURITY_SCAN_SLICE_JOB_ID_ENV];
    return typeof jobId === 'string' && jobId.length > 0;
}

export function securityScanSliceJobId(
    env: NodeJS.ProcessEnv = process.env,
): string | undefined {
    const jobId = env[SECURITY_SCAN_SLICE_JOB_ID_ENV];
    return typeof jobId === 'string' && jobId.length > 0 ? jobId : undefined;
}

/**
 * How long a PROCESSING inbox row can sit without a heartbeat before
 * another worker may steal it. The parent heartbeats while the child
 * runs, so a live slice is never stolen; a dead parent is stealable in
 * minutes instead of the previous 45.
 */
export const SECURITY_SCAN_CLAIM_TIMEOUT_MINUTES = 3;

/** Parent refreshes lockedAt this often while the child is running. */
export const SECURITY_SCAN_CLAIM_HEARTBEAT_MS = 30_000;

/**
 * Abort the child only after this long without a successful heartbeat.
 * Shorter than the 3 min steal window so we stop before another worker
 * takes the claim; longer than one Postgres blip.
 */
export const SECURITY_SCAN_HEARTBEAT_STALE_MS = 2 * 60 * 1000;

export { CLAIM_CONFLICT_REQUEUE_DELAY_MS } from '../domain/errors/claim-conflict.error';

/**
 * Parent-side ceiling on waiting for the child. The router already cuts
 * the slice at 34 min; this is a backstop so a lost 'exit' cannot hold
 * the AMQP delivery until x-consumer-timeout (40 min).
 */
export const SECURITY_SCAN_PARENT_WAIT_MS = 36 * 60 * 1000;
