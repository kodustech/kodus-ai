import { KodyRuleHealthState, KodyRuleUsageRow } from '../types';

/**
 * Pure rule-health classification, shared by the cockpit rule-health use-case
 * and the report builders. Lives in the domain so SERVICES can use it without
 * importing a use-case (which would invert the use-case → service direction).
 *
 * States:
 *  - `stale`     active rule with zero triggers in the window
 *  - `low_data`  triggered, but not enough sample to judge
 *  - `noisy`     the team actively downvotes this rule — AND those downvotes
 *                are a meaningful share of how often it fires, so a few
 *                scattered 👎 on a high-volume rule don't false-alarm
 *  - `ignored`   triggers a lot, almost nothing gets implemented
 *  - `healthy`   everything else
 *
 * `noisy` outranks `ignored`: explicit disagreement is a stronger signal
 * than passive inaction, and its fix is different (rewrite/scope the rule
 * vs. ask whether it matters at all).
 */

const MIN_TRIGGERS_TO_JUDGE = 5;
const IGNORED_MAX_RATE = 0.2;
const NOISY_MIN_THUMBS_DOWN = 3;
// Downvotes must also clear a proportional bar — at least this share of the
// rule's firings drew a 👎. An absolute count alone flags high-volume rules
// on a handful of scattered downvotes (e.g. 4 👎 over 74 triggers = 5%),
// which reads as noise from the alert itself rather than a real signal.
const NOISY_MIN_DOWNVOTE_RATE = 0.1;

export function computeRuleState(usage: KodyRuleUsageRow | undefined): {
    state: KodyRuleHealthState;
    usage: Omit<KodyRuleUsageRow, 'ruleId'>;
} {
    if (!usage || usage.triggers === 0) {
        return {
            state: 'stale',
            usage: {
                triggers: 0,
                implemented: 0,
                rate: 0,
                thumbsUp: usage?.thumbsUp ?? 0,
                thumbsDown: usage?.thumbsDown ?? 0,
                lastTriggeredAt: usage?.lastTriggeredAt ?? null,
            },
        };
    }

    const {
        triggers,
        implemented,
        rate,
        thumbsUp,
        thumbsDown,
        lastTriggeredAt,
    } = usage;
    let state: KodyRuleHealthState = 'healthy';
    if (triggers < MIN_TRIGGERS_TO_JUDGE) {
        state = 'low_data';
    } else if (
        thumbsDown >= NOISY_MIN_THUMBS_DOWN &&
        thumbsDown > thumbsUp &&
        thumbsDown / triggers >= NOISY_MIN_DOWNVOTE_RATE
    ) {
        state = 'noisy';
    } else if (rate <= IGNORED_MAX_RATE) {
        state = 'ignored';
    }
    return {
        state,
        usage: {
            triggers,
            implemented,
            rate,
            thumbsUp,
            thumbsDown,
            lastTriggeredAt,
        },
    };
}
