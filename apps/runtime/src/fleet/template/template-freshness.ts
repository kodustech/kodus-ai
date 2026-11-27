import { createHash } from 'crypto';

import { DEFAULT_TEMPLATE_FRESHNESS, type TemplateFreshnessPolicy } from '../../shared/config';
import type { ReadyTemplate } from './template-store';

// The freshness bound (docs/runtime/host-providers.md §8.2.2). A template keyed by its build inputs keeps serving while
// main moves past the commit it holds: the side's build brings the newer code in on top of the template's cache and images.
// That drift is bounded: a template older than `maxAgeDays`, or `maxMainCommits` main commits behind, is built again anyway.

export type { TemplateFreshnessPolicy };
export { DEFAULT_TEMPLATE_FRESHNESS };

const DAY_MS = 86_400_000;

/** Why a ready template is rebuilt although its key is unchanged, or null while it is fresh enough. */
export function staleReason(t: Pick<ReadyTemplate, 'ageMs' | 'commitsBehind'>, p: TemplateFreshnessPolicy): 'max_age' | 'max_main_commits' | null {
    if (p.maxAgeDays > 0 && t.ageMs >= p.maxAgeDays * DAY_MS) return 'max_age';
    if (p.maxMainCommits > 0 && t.commitsBehind >= p.maxMainCommits) return 'max_main_commits';
    return null;
}

/**
 * The row fingerprint of a freshness rebuild of `inputKey`: another value, so the older ready template (same key) keeps
 * serving while this one builds, and its snapshot has a name of its own. `nonce` makes each rebuild distinct.
 */
export function refreshFingerprintOf(inputKey: string, nonce: string): string {
    return createHash('sha256').update(`refresh:1\0${inputKey}\0${nonce}`).digest('hex');
}
