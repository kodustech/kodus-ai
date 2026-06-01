import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

/**
 * Maximum allowed length (in characters) for a PR description, per
 * git-platform. Each value is sourced from official docs, source
 * code, or live API error messages — not guesses.
 *
 * - **AZURE_REPOS** (4 000):
 *   API enforced. Exceeding it returns HTTP 400 with
 *   `InvalidArgumentValueException`:
 *     "A description for a pull request must not be longer than 4000
 *      characters."
 *   The official Azure DevOps Git REST docs don't document the
 *   number; the value comes from the live API response observed in
 *   production (see issue #1045 root-cause).
 *
 * - **BITBUCKET** (32 768):
 *   Confirmed by Atlassian staff on the community thread "For the
 *   Pull Request API call - is it possible to get the max lengths of
 *   the data fields?" — the description (and the new branch name)
 *   field is capped at 32 768 chars.
 *
 * - **GITHUB** (65 536):
 *   API enforced. Exceeding it returns HTTP 422 with:
 *     "Validation failed: Body is too long (maximum is 65536
 *      characters)"
 *   Reproduced by many open-source projects:
 *     renovatebot/renovate#14551, mshick/add-pr-comment#93,
 *     changesets/action#174, reviewdog/reviewdog#1065.
 *   GitHub also evaluates the gzipped payload, so very compressible
 *   content can pass even if raw is larger — but at the API
 *   contract level the documented behaviour is 65 536.
 *
 * - **GITLAB** (1 048 576 = 1 MiB):
 *   Source-of-truth: `app/models/concerns/issuable.rb` validates
 *   `:description, bytesize: { maximum: -> { Gitlab::CurrentSettings
 *   .description_and_note_max_size } }` and the default in
 *   `app/models/application_setting.rb` is `1.megabyte`. Self-hosted
 *   admins can lower it; we use the default since the cloud runs it.
 *
 * - **FORGEJO** (1 048 576 = 1 MiB):
 *   The schema column is `LONGTEXT` (`models/issues/issue.go:Content`
 *   field) — effectively 4 GB at the database level — and the form
 *   validator (`services/forms/repo_form.go:CreateIssueForm`) puts
 *   no `MaxSize` constraint on `Content`. The API never rejects on
 *   length. We pick 1 MiB (matching GitLab) as a sane application
 *   ceiling so we don't ship a multi-MB description into a tiny
 *   self-hosted instance just because the API doesn't push back.
 *
 * If a new platform is added without an entry here, `fitPRDescription`
 * leaves the description unchanged (no truncation).
 */
export const PR_DESCRIPTION_LIMITS: Partial<Record<PlatformType, number>> = {
    [PlatformType.AZURE_REPOS]: 4_000,
    [PlatformType.BITBUCKET]: 32_768,
    [PlatformType.GITHUB]: 65_536,
    [PlatformType.GITLAB]: 1_048_576,
    [PlatformType.FORGEJO]: 1_048_576,
};

const TRUNCATION_NOTICE =
    '\n\n_…(truncated by Kody to fit the platform description size limit)_\n';

const SUMMARY_END_MARKER = '<!-- kody-pr-summary:end -->';

/**
 * Truncate a PR description to fit the per-platform limit, preserving
 * the closing summary marker so the next run's "previous summary"
 * detection (`commentManager.service.ts`) still works.
 *
 * Behaviour:
 *   1. If `description.length <= limit` → returns unchanged.
 *   2. If the description ends with `<!-- kody-pr-summary:end -->` →
 *      keeps the marker intact, slices content from the start, appends
 *      a truncation notice immediately before the marker.
 *   3. Otherwise → hard slice from the end, append the truncation
 *      notice.
 *
 * Returns the original description for any platform without a limit
 * registered in `PR_DESCRIPTION_LIMITS` (no-op for unknown platforms).
 */
export function fitPRDescription(
    description: string,
    platform: PlatformType,
): string {
    const limit = PR_DESCRIPTION_LIMITS[platform];
    if (limit === undefined || description.length <= limit) {
        return description;
    }

    if (description.endsWith(SUMMARY_END_MARKER)) {
        const budget = limit - TRUNCATION_NOTICE.length - SUMMARY_END_MARKER.length;
        if (budget <= 0) {
            // Pathological: the marker + notice alone exceed the limit.
            // Fall through to hard slice — the regex on subsequent runs
            // will fail to find the closing marker and treat the body
            // as having no previous summary, which is the safe default.
            return description.slice(0, limit);
        }
        return description.slice(0, budget) + TRUNCATION_NOTICE + SUMMARY_END_MARKER;
    }

    return description.slice(0, limit - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
}

/**
 * Returns the per-platform character budget callers (e.g. the LLM
 * prompt that generates the summary) should aim for. Same map as
 * `PR_DESCRIPTION_LIMITS`, exposed separately for clarity at call
 * sites that don't perform truncation themselves.
 *
 * Returns `null` for platforms without a registered limit so callers
 * can decide whether to skip the constraint or apply a default.
 */
export function getPRDescriptionLimit(
    platform: PlatformType,
): number | null {
    return PR_DESCRIPTION_LIMITS[platform] ?? null;
}
