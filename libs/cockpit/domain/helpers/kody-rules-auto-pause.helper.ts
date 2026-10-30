import {
    IKodyRule,
    KodyRuleAutoPauseState,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { KodyRuleUsageRow } from '../types';
import { computeRuleState } from './kody-rules-health.helper';

/** Same look-back the Kody Rules page uses to label rule health. */
export const AUTO_PAUSE_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type AutoPauseSkipReason =
    'not_active' | 'setting_off' | 'centralized_config' | 'healthy';

export type AutoPauseDecision =
    | { action: 'pause'; state: KodyRuleAutoPauseState }
    | { action: 'skip'; reason: AutoPauseSkipReason };

/**
 * Whether the auto-pause cron pauses a rule. Cockpit labels a rule `noisy`
 * over `ignored` when both apply, and either one pauses.
 */
export function decideAutoPause(input: {
    rule: Pick<IKodyRule, 'status'>;
    usage: KodyRuleUsageRow | undefined;
    settingOn: boolean;
    /** The rule lives in a config repository, where a pause opens a PR. */
    centralized: boolean;
}): AutoPauseDecision {
    if (input.rule.status !== KodyRulesStatus.ACTIVE) {
        return { action: 'skip', reason: 'not_active' };
    }
    if (!input.settingOn) {
        return { action: 'skip', reason: 'setting_off' };
    }
    if (input.centralized) {
        return { action: 'skip', reason: 'centralized_config' };
    }

    const { state } = computeRuleState(input.usage);
    if (state === 'ignored' || state === 'noisy') {
        return { action: 'pause', state };
    }
    return { action: 'skip', reason: 'healthy' };
}

/**
 * Start of the usage window a rule is judged on: the full window, or the last
 * resume when it is more recent, so a resumed rule isn't re-paused on the
 * history that paused it.
 */
export function autoPauseWindowStart(
    now: Date,
    resumedAt: Date | string | null | undefined,
): Date {
    const fullWindow = new Date(
        now.getTime() - AUTO_PAUSE_WINDOW_DAYS * DAY_MS,
    );
    if (!resumedAt) return fullWindow;

    const resumed = new Date(resumedAt);
    if (Number.isNaN(resumed.getTime())) return fullWindow;
    return resumed > fullWindow ? resumed : fullWindow;
}
