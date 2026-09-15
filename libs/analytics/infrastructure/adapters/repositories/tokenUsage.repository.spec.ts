import { TokenUsageRepository } from './tokenUsage.repository';
import { TokenUsageQueryContract } from '@libs/analytics/domain/token-usage/types/tokenUsage.types';

/**
 * Regression coverage for issue #1882: the repository filter used to scope
 * on `attributes.prNumber` (or the `prNumbers` list the service pre-resolved)
 * — PR numbers are unique per repository, not per org, so two repositories
 * that happen to share a number were indistinguishable to Mongo. Fixed by
 * matching `attributes.repositoryId` directly, since every usage span now
 * carries its own repository id.
 *
 * `_tuMatch` is pure (it only reads its `query` argument), so we exercise it
 * off the prototype without wiring the repository's Mongo deps — same pattern
 * as the `_tierExpr` suite below. A tiny in-memory interpreter re-implements
 * just enough of Mongo's `$match` semantics ($in / $gte+$lte / $type / eq) to
 * evaluate the real match object against fixture span documents, so these
 * tests exercise the actual production match-builder, not a re-description
 * of it.
 */
function applyMongoMatch(
    doc: Record<string, any>,
    match: Record<string, any>,
): boolean {
    const get = (obj: any, path: string) =>
        path.split('.').reduce((v, k) => v?.[k], obj);
    return Object.entries(match).every(([key, cond]) => {
        const value = get(doc, key);
        if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
            if ('$in' in cond) return cond.$in.includes(value);
            if ('$type' in cond) return typeof value === 'number';
            if ('$gte' in cond || '$lte' in cond) {
                if ('$gte' in cond && !(value >= cond.$gte)) return false;
                if ('$lte' in cond && !(value <= cond.$lte)) return false;
                return true;
            }
        }
        return value === cond;
    });
}

describe('TokenUsageRepository._tuMatch — repository scope (#1882)', () => {
    const tuMatch = (query: TokenUsageQueryContract) =>
        (TokenUsageRepository.prototype as any)['_tuMatch'].call(
            Object.create(TokenUsageRepository.prototype),
            query,
        );

    const baseQuery = (
        over: Partial<TokenUsageQueryContract> = {},
    ): TokenUsageQueryContract =>
        ({
            organizationId: 'org-1',
            start: new Date('2026-06-01'),
            end: new Date('2026-06-30'),
            byok: true,
            ...over,
        }) as TokenUsageQueryContract;

    it('two repositories that happen to share a PR number produce DIFFERENT Mongo matches', () => {
        const matchScopedToRepoA = tuMatch(baseQuery({ repositoryId: 'repo-a' }));
        const matchScopedToRepoB = tuMatch(baseQuery({ repositoryId: 'repo-b' }));

        expect(matchScopedToRepoA).not.toEqual(matchScopedToRepoB);
        // `_tuMatch` keys are literal dotted strings (Mongo's own convention),
        // not a nested object — so this reads the flat key directly.
        expect(matchScopedToRepoA['attributes.repositoryId']).toBe('repo-a');
        expect(matchScopedToRepoB['attributes.repositoryId']).toBe('repo-b');
    });

    it('filtering by repository A excludes a span whose review actually ran on repository B', () => {
        // Minimal fixture from the issue: repo A and repo B both have a PR #1;
        // the usage span was produced by a review of repo B's PR #1.
        const spanFromRepoB = {
            attributes: {
                organizationId: 'org-1',
                prNumber: 1,
                repositoryId: 'repo-b',
                tu: { isByok: true },
            },
            timestamp: new Date('2026-06-15'),
        };

        const matchForRepoA = tuMatch(baseQuery({ repositoryId: 'repo-a' }));
        const matchForRepoB = tuMatch(baseQuery({ repositoryId: 'repo-b' }));

        expect(applyMongoMatch(spanFromRepoB, matchForRepoA)).toBe(false);
        expect(applyMongoMatch(spanFromRepoB, matchForRepoB)).toBe(true);
    });

    it('a span with no prNumber (only pullRequestId) still matches its own repository filter', () => {
        // Per the issue: "some secondary passes stamp only organizationId, or
        // pullRequestId instead of prNumber" — those used to be invisible once
        // a repo filter narrowed the match to `attributes.prNumber: {$in:[...]}`.
        // The fix scopes on repositoryId alone, so these are no longer dropped.
        const spanWithoutPrNumber = {
            attributes: {
                organizationId: 'org-1',
                pullRequestId: 'some-pr-doc-id',
                repositoryId: 'repo-a',
                tu: { isByok: true },
            },
            timestamp: new Date('2026-06-15'),
        };

        const matchScopedToRepoA = tuMatch(baseQuery({ repositoryId: 'repo-a' }));

        expect(applyMongoMatch(spanWithoutPrNumber, matchScopedToRepoA)).toBe(
            true,
        );
    });

    it('a span written before this fix (no attributes.repositoryId) does not match any repository filter', () => {
        const legacySpan = {
            attributes: {
                organizationId: 'org-1',
                prNumber: 1,
                tu: { isByok: true },
            },
            timestamp: new Date('2026-06-15'),
        };

        const matchScopedToRepoA = tuMatch(baseQuery({ repositoryId: 'repo-a' }));

        expect(applyMongoMatch(legacySpan, matchScopedToRepoA)).toBe(false);
    });
});

/**
 * Regression coverage for the tier expression the aggregation pipelines share.
 *
 * `_tierExpr` is pure (it only reads its `thresholds` argument), so we exercise
 * it off the prototype without wiring the repository's Mongo deps.
 */
describe('TokenUsageRepository._tierExpr', () => {
    const call = (thresholds: Map<string, number[]>) =>
        (TokenUsageRepository.prototype as any)['_tierExpr'].call(
            Object.create(TokenUsageRepository.prototype),
            thresholds,
        );

    it('degrades to a literal 0 (not a bare 0) when no model is tiered', () => {
        // A bare `0` in the overview `$project` is read by Mongo as field
        // EXCLUSION and crashes the mixed projection with "Cannot do exclusion
        // on field tier in inclusion projection" — real bug caught against prod
        // data when the pricing catalog fetch returned empty. `$literal` forces
        // the VALUE 0 (bracket 0 = default band), safe in both $project and
        // $addFields.
        const expr = call(new Map());
        expect(expr).toEqual({ $literal: 0 });
        expect(expr).not.toBe(0);
    });

    it('returns a computed bracket-index expression when a model is tiered', () => {
        const expr = call(new Map([['gemini-3.1-pro-preview', [200000]]]));
        // A computed object (not a bare number) is a valid $project field.
        expect(typeof expr).toBe('object');
        expect(expr.$literal).toBeUndefined();
        expect(expr.$let).toBeDefined();
        // Bracket index = count of thresholds the call's input exceeds.
        expect(expr.$let.in.$size.$filter.cond).toEqual({
            $gt: ['$attributes.tu.input', '$$t'],
        });
        const branch = expr.$let.vars.thrs.$switch.branches[0];
        expect(branch).toEqual({
            case: { $eq: ['$attributes.tu.model', 'gemini-3.1-pro-preview'] },
            then: [200000],
        });
    });
});
