/**
 * Enterprise Code — see `license_ee.md`. What Kody says on a pull request
 * about an Ultra review.
 */
import type {
    UltraReviewState,
    UltraRunOutcome,
} from '@libs/code-review/domain/ultra-review-state';
import type { UltraTrioRefusal } from './ultra-review-plan';

const appUrl = (): string =>
    (process.env.API_USER_INVITE_BASE_URL || 'https://app.kodus.io').replace(
        /\/+$/,
        '',
    );

/** Where the team picks the three Ultra models. */
export const ultraRoutingSettingsUrl = (): string =>
    `${appUrl()}/settings/code-review/global/routing`;

/** This pull request on the Pull Requests screen, where each run shows. */
export function ultraPullRequestScreenUrl(input: {
    repositoryName?: string;
    prNumber?: number;
}): string {
    const params = new URLSearchParams();
    if (input.repositoryName) params.set('repo', input.repositoryName);
    if (input.prNumber) {
        params.set('q', String(input.prNumber));
        params.set('by', 'number');
    }
    const query = params.toString();
    return `${appUrl()}/pull-requests${query ? `?${query}` : ''}`;
}

const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;

const NOT_REVIEWED =
    'This pull request was not reviewed. `@kody start-review --heavy` or `--balanced` reviews it on one model.';

/** Why an Ultra review was refused on the plan. */
export const ULTRA_REVIEW_PLAN_REQUIRED =
    'Ultra review is available on the Teams and Enterprise plans, and on a trial with three of your own models, and Kody could not confirm this organization is on one. This pull request was not reviewed. `@kody start-review --balanced` reviews it in Balanced mode.';

/** The skip of a refusal whose reply the platform did not take. */
export const ULTRA_REFUSAL_NOT_POSTED =
    'Ultra review was refused, and Kody could not post why on the pull request. The next review of it tries again.';

/** Why an Ultra review was refused on the org's models. */
export function ultraTrioRefusalMessage(refusal: UltraTrioRefusal): string {
    const settings = `[Settings › Code review › Routing](${ultraRoutingSettingsUrl()})`;
    switch (refusal.reason) {
        case 'too_few_models':
            return `Ultra review runs on three of your own models, and this organization has ${refusal.ownModels} configured. Add models with your own keys in AI providers and pick three for Ultra in ${settings}. ${NOT_REVIEWED}`;
        case 'not_configured':
            return `Ultra review runs on three different models set for it, and this organization does not have three set. Pick them under Ultra models in ${settings}. ${NOT_REVIEWED}`;
        case 'same_model':
            return `Ultra review runs on three different models, and two of the three set for it are ${code(refusal.model)}. Pick another under Ultra models in ${settings}. ${NOT_REVIEWED}`;
        case 'unavailable_models':
            return `None of the three models set for Ultra review can run any more: they were removed, or their keys were. Pick three again under Ultra models in ${settings}. ${NOT_REVIEWED}`;
        case 'some_unavailable':
            return `${refusal.unavailable} of the three models set for Ultra review cannot run. Pick them again under Ultra models in ${settings}. ${NOT_REVIEWED}`;
    }
}

/**
 * Why a saved Ultra mode was refused. Each starts with "Ultra review": the
 * web shows the API's message only on that prefix.
 */
export function ultraSaveRefusalMessage(
    refusal: UltraTrioRefusal | 'plan',
): string {
    if (refusal === 'plan') {
        return 'Ultra review is available on the Teams and Enterprise plans, and on a trial with three of your own models, and Kody could not confirm this organization is on one, so the review mode was not changed.';
    }
    switch (refusal.reason) {
        case 'too_few_models':
            return `Ultra review needs three of your own models, and this organization has ${refusal.ownModels}, so the review mode was not changed.`;
        case 'not_configured':
            return 'Ultra review needs three different models set under Ultra models in Routing, so the review mode was not changed.';
        case 'same_model':
            return `Ultra review needs three different models, and two of the three set for it are ${code(refusal.model)}, so the review mode was not changed.`;
        case 'unavailable_models':
            return 'Ultra review cannot run on any of the three models set for it any more, so the review mode was not changed.';
        case 'some_unavailable':
            return `Ultra review cannot run on ${refusal.unavailable} of the three models set for it: each must be one of your own models, with its key. The review mode was not changed.`;
    }
}

const label = (run: { position: UltraRunOutcome['position'] }): string =>
    run.position === 'fallback' ? 'Fallback' : `Model ${run.position}`;

/** What each model run ended as, one line per model, for the notice. */
function runLines(state: UltraReviewState): string[] {
    const lines: string[] = [];
    const runs = state.runs ?? [];
    // Before the runs, a model the config no longer resolves; once they ran,
    // it is among them as a failed run (runUltraModels), listed once.
    if (!runs.length) {
        for (const missing of state.unavailable ?? []) {
            lines.push(
                `- Model ${missing.position} (${code(missing.modelId)}) did not run: ${missing.reason}`,
            );
        }
    }
    const byModelId = new Map(runs.map((r) => [r.modelId, r]));
    for (const run of runs) {
        if (run.position === 'fallback') continue;
        if (run.status === 'completed') {
            lines.push(`- ${label(run)} (${code(run.modelName)}) completed.`);
            continue;
        }
        const why = run.failureReason ? `: ${run.failureReason}` : '.';
        const replacement = run.replacedBy
            ? byModelId.get(run.replacedBy)
            : undefined;
        let then =
            ' It was not replaced: the fallback was already used, or none is set.';
        if (run.reusedRun) {
            then = ` The fallback, ${code(replacement?.modelName ?? run.replacedBy ?? '')}, is one of the three models, so its review counted once.`;
        } else if (replacement) {
            then =
                replacement.status === 'completed'
                    ? ` The fallback ${code(replacement.modelName)} took its place and completed.`
                    : ` The fallback ${code(replacement.modelName)} took its place and failed too${replacement.failureReason ? `: ${replacement.failureReason}` : '.'}`;
        }
        lines.push(
            `- ${label(run)} (${code(run.modelName)}) failed${why}${then}`,
        );
    }
    return lines;
}

function mergeLine(state: UltraReviewState): string | undefined {
    const merge = state.merge;
    if (!merge) return undefined;
    switch (merge.status) {
        case 'success':
            return undefined;
        case 'fallback':
            return `- The merge model failed; the comments were merged on the fallback ${code(merge.modelName ?? '')}.`;
        case 'failed':
            return '- The comments were posted without the final merge: the merge model and the fallback failed, so some comments may repeat.';
        case 'skipped':
            return '- Fewer than two models left comments, so there was nothing to merge.';
    }
}

/**
 * The system notice a degraded Ultra review posts on the pull request, whatever
 * the final comment's settings: what ran, what failed, and where to see it.
 */
export function ultraDegradedNotice(
    state: UltraReviewState,
    link: { repositoryName?: string; prNumber?: number },
): string {
    const completed = completedModelCount(state);
    const lines = [
        '## Ultra review did not run as configured',
        '',
        ...runLines(state),
    ];
    const merge = mergeLine(state);
    if (merge) lines.push(merge);
    if (state.auxiliaryMissed) {
        lines.push(
            '- Kody Rules and custom agents did not finish in time, so their comments are not in this review.',
        );
    }
    lines.push(
        '',
        completed > 0
            ? `${completed} of 3 models completed, and their comments were posted. Automatic approval is held for this review.`
            : (state.runs ?? []).some((r) => (r.findings ?? 0) > 0)
              ? 'No model completed. The comments the models found before they stopped were posted. Automatic approval is held for this review.'
              : 'No model completed, and none left comments to post.',
        '',
        `[See this review on the Pull Requests screen](${ultraPullRequestScreenUrl(link)})`,
        '',
        '<!-- kody-ultra-review-notice -->',
    );
    return lines.join('\n');
}

/**
 * The line a successful Ultra review that needed its fallback adds to the
 * final comment. Any other outcome posts the notice, which tells it all.
 */
export function ultraFallbackInfoLine(
    state: UltraReviewState,
): string | undefined {
    if (state.outcome !== 'success') return undefined;
    const replaced = (state.runs ?? []).find(
        (r) => r.position !== 'fallback' && r.replacedBy && !r.reusedRun,
    );
    if (!replaced) return undefined;
    const fallback = (state.runs ?? []).find((r) => r.position === 'fallback');
    return `> Ultra review: ${code(replaced.modelName)} failed, and the fallback ${code(fallback?.modelName ?? replaced.replacedBy ?? '')} took its place.`;
}

/** Distinct models whose heavy review completed. */
export function completedModelCount(state: UltraReviewState): number {
    return new Set(
        (state.runs ?? [])
            .filter((r) => r.status === 'completed')
            .map((r) => r.modelId),
    ).size;
}
