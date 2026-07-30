/** Per-period alert state carried in the org's SpendLimitConfig. */
export interface SpendAlertState {
    thresholdsSent?: number[];
    finalNoticeSent?: boolean;
}

export interface SpendAlertDecision {
    /** Thresholds to send a "reached N%" alert for now (newly crossed). */
    thresholdsToAlert: number[];
    /** Whether to send the one-time "over limit, won't notify again" notice. */
    sendFinalNotice: boolean;
    /** State to persist for this period after acting on the decision. */
    nextThresholdsSent: number[];
    nextFinalNoticeSent: boolean;
    /** True when persisting is needed (something was alerted or state moved). */
    changed: boolean;
}

/**
 * Decide which spend alerts to emit, given a fresh evaluation and the alerts
 * already sent this period. Pure and idempotent: each threshold alerts at most
 * once, and the final "won't notify again" notice fires exactly one tick after
 * 100% was alerted (so users get the 100% alert, then the sign-off), then the
 * org goes silent for the rest of the period.
 */
export function decideSpendAlerts(
    evaluation: { crossedThresholds: number[]; isOverLimit: boolean },
    state: SpendAlertState = {},
): SpendAlertDecision {
    const sent = state.thresholdsSent ?? [];
    const finalNoticeSent = state.finalNoticeSent ?? false;

    const thresholdsToAlert = evaluation.crossedThresholds.filter(
        (t) => !sent.includes(t),
    );
    const nextThresholdsSent = [
        ...new Set([...sent, ...evaluation.crossedThresholds]),
    ].sort((a, b) => a - b);

    // Final notice waits until 100% was alerted on a PRIOR tick — never the
    // same tick — so it always lands after the 100% alert, never merged with it.
    const sendFinalNotice =
        evaluation.isOverLimit && sent.includes(100) && !finalNoticeSent;
    const nextFinalNoticeSent = finalNoticeSent || sendFinalNotice;

    return {
        thresholdsToAlert,
        sendFinalNotice,
        nextThresholdsSent,
        nextFinalNoticeSent,
        changed: thresholdsToAlert.length > 0 || sendFinalNotice,
    };
}
