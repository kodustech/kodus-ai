import { KodyLearningStatus } from '@libs/organization/domain/parameters/types/configValue.type';

/**
 * How long a `generating_*` `kodyLearningStatus` may persist before the
 * KodyLearning cron treats it as a dead run and regenerates.
 *
 * Rule generation now runs detached (via `setImmediate` in
 * `FinishOnboardingUseCase`), so an API restart mid-run can leave a team
 * stuck in `generating_rules` forever — the cron is the safety net.
 * 30 minutes is comfortably longer than any real run.
 */
export const STALE_GENERATING_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Whether a `generating_*` status is stale — i.e. likely left behind by a
 * crashed/restarted run rather than a genuine in-progress one.
 *
 * Returns `false` for non-generating statuses (nothing to recover). A
 * missing timestamp is treated as stale: regenerating is safer than
 * skipping a team forever.
 */
export function isKodyLearningStatusStale(
    status: KodyLearningStatus | undefined,
    updatedAt: Date | undefined,
    now: number = Date.now(),
): boolean {
    const isGenerating =
        status === KodyLearningStatus.GENERATING_CONFIG ||
        status === KodyLearningStatus.GENERATING_RULES;

    if (!isGenerating) {
        return false;
    }

    const updatedAtMs = updatedAt ? new Date(updatedAt).getTime() : 0;
    return now - updatedAtMs >= STALE_GENERATING_THRESHOLD_MS;
}

/**
 * How many consecutive hard-crashed rule-generation runs the KodyLearning
 * cron will retry before giving up on a team. Past this it leaves the team
 * alone (and logs an error) rather than re-crashing the process on every
 * cron tick. `GenerateKodyRulesUseCase` bumps the count when it enters
 * `GENERATING_RULES` and resets it to 0 on any completion, so it only
 * accumulates when a run dies without finishing.
 */
export const MAX_STUCK_RETRIES = 5;

/**
 * Whether the cron should stop retrying a stuck team — its rule generation
 * has hard-crashed `MAX_STUCK_RETRIES` times in a row.
 */
export function hasExhaustedStuckRetries(
    retries: number | undefined,
): boolean {
    return (retries ?? 0) >= MAX_STUCK_RETRIES;
}
