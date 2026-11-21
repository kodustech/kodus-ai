import { isKodyRuntimeEnabled } from '@libs/runtime-publish/runtime-feature';

import { HealthProbeOptions, SECURITY_SCAN_WORKER_CHANNELS } from './health-probe';
import type { WorkerRole } from './worker-role';

/**
 * What the health probe checks for each worker role.
 *
 * The code-review and security-scan roles subscribe to AMQP, each on its own
 * channels. The analytics role has no consumers, so checking AMQP there
 * would flap the task unhealthy permanently.
 *
 * Only code-review runs the outbox relay, and its liveness is checked only
 * where the Kody Runtime is on: with it off, the probe is the one code
 * review always had, and a stalled relay cycle (a long event-loop block, a
 * slow claim) never recycles a worker in the middle of a review.
 */
export function workerHealthProbeOptions(
    role: WorkerRole,
    env: NodeJS.ProcessEnv,
): Pick<
    HealthProbeOptions,
    'requireAmqp' | 'requireOutboxRelay' | 'requiredChannels'
> {
    return {
        requireAmqp:
            role !== 'analytics' && env.API_RABBITMQ_ENABLED !== 'false',
        requireOutboxRelay:
            role === 'code-review' && isKodyRuntimeEnabled(env),
        ...(role === 'security-scan'
            ? { requiredChannels: SECURITY_SCAN_WORKER_CHANNELS }
            : {}),
    };
}
