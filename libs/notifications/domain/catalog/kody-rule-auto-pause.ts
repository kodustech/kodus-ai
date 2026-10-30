import { rulesPageLink } from './app-links';
import { KodyRuleAutoPauseEntry } from './events';

/** Coerce a payload's rule list, dropping entries a template can't render. */
export function normaliseAutoPauseEntries(
    value: unknown,
): KodyRuleAutoPauseEntry[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
        (entry): entry is KodyRuleAutoPauseEntry =>
            !!entry &&
            typeof entry === 'object' &&
            typeof (entry as KodyRuleAutoPauseEntry).ruleId === 'string' &&
            typeof (entry as KodyRuleAutoPauseEntry).title === 'string',
    );
}

/** Why the rule was paused, with the numbers behind it. */
export function describeAutoPauseReason(entry: KodyRuleAutoPauseEntry): string {
    const window = entry.sinceResume
        ? 'since it was last resumed'
        : `in the last ${entry.windowDays} ${entry.windowDays === 1 ? 'day' : 'days'}`;
    if (entry.state === 'noisy') {
        return `Noisy: ${entry.thumbsDown} 👎 and ${entry.thumbsUp} 👍 on ${entry.triggers} suggestions ${window}.`;
    }
    return `Ignored: ${entry.implemented} of ${entry.triggers} suggestions implemented ${window}.`;
}

/** Opens the rule on the rules page of its scope. */
export function autoPausedRuleLink(entry: KodyRuleAutoPauseEntry): string {
    return rulesPageLink({
        repositoryId: entry.repositoryId ?? undefined,
        directoryId: entry.directoryId ?? undefined,
        ruleId: entry.ruleId,
    });
}
