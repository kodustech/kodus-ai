"use client";

import { DecisionTab, type DecisionTabProps } from "./decision-tab";

/**
 * Feature-flag gate for the DecisionTab. Per `tasks.md §6.3`:
 *   FEATURE_PR_DECISION_TAB enables the in-app Decision tab
 *   on the per-PR route. Default: off.
 *
 * The flag is read off the build-time env `NEXT_PUBLIC_FEATURE_PR_DECISION_TAB`
 * because the web app's existing feature-flag posthis table is empty
 * (see `libs/common/utils/posthog/index.ts`) and the change treats the
 * rollout as opt-in per tenant until parity is measured (§7).
 */
export function isDecisionTabEnabled(): boolean {
    return (
        typeof process !== 'undefined' &&
        process.env?.NEXT_PUBLIC_FEATURE_PR_DECISION_TAB === 'true'
    );
}

export interface DecisionTabGateProps extends DecisionTabProps {
    flagEnabled?: boolean;
}

/**
 * Renders DecisionTab only when the feature flag is on. Defaults to the
 * env-var read if `flagEnabled` is not explicitly passed (used by tests).
 */
export function DecisionTabGate(props: DecisionTabGateProps) {
    const enabled = props.flagEnabled ?? isDecisionTabEnabled();
    if (!enabled) return null;
    const { flagEnabled: _ignored, ...rest } = props;
    return <DecisionTab {...rest} />;
}
