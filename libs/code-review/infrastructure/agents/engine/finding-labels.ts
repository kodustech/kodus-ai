/**
 * The finding labels the review routes (#1821), in one place: the finder's
 * submitResult enum, its recovery, label normalization and the team's
 * category filter all read them from here.
 */

/** The categories a team turns on or off (reviewOptions). */
export const CATEGORY_LABELS = ['bug', 'security', 'performance'] as const;

/** What the generalist finder may label a finding. */
export const FINDER_LABELS = [...CATEGORY_LABELS, 'repo_instruction'] as const;
export type FinderLabel = (typeof FINDER_LABELS)[number];

/** Every label the pipeline routes; Kody Rules findings carry their own. */
export const VALID_FINDING_LABELS = [...FINDER_LABELS, 'kody_rules'] as const;
