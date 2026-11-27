import {
    reviewModeOfExecution,
    agentReviewMode,
    isHeavyReview,
    isUltraReview,
    lastReviewModeOf,
    resolveRiskReviewMode,
} from './review-mode';
import type { RiskAssessmentResult } from './risk/risk-assessment';

describe('risk review routing', () => {
    const snapshot = {
        organizationId: 'org',
        repositoryId: 'repo',
        prNumber: 5,
        baseSha: 'base',
        headSha: 'head',
        assessmentKey: 'key',
    };
    const assessed = (riskIdentified: boolean): RiskAssessmentResult => ({
        status: 'assessed',
        riskIdentified,
        reason: 'Evidence.',
        snapshot,
    });
    const route = (
        overrides: Partial<Parameters<typeof resolveRiskReviewMode>[0]> = {},
    ) =>
        resolveRiskReviewMode({
            currentHeadSha: 'head',
            heavyAllowed: true,
            ...overrides,
        });

    it('routes confirmed risk to Heavy and no-risk to Balanced by default', () => {
        expect(route({ risk: assessed(true) })).toBe('heavy');
        expect(route({ risk: assessed(false) })).toBe('balanced');
    });
    it('honors team routing for both results', () => {
        const routing = { noRisk: 'heavy', riskFound: 'balanced' } as const;
        expect(route({ risk: assessed(true), routing })).toBe('balanced');
        expect(route({ risk: assessed(false), routing })).toBe('heavy');
    });
    it.each([
        undefined,
        { status: 'disabled' },
        { status: 'unavailable', reason: 'Timeout.' },
    ] as const)(
        'uses the configured default for %j without forcing Heavy',
        (risk) => {
            expect(route({ risk })).toBe('balanced');
            expect(route({ risk, configured: 'heavy' })).toBe('heavy');
        },
    );
    it('ignores a judgment on an earlier head', () => {
        expect(
            route({ risk: assessed(true), currentHeadSha: 'new-head' }),
        ).toBe('balanced');
    });
    it('lets explicit commands override both routing branches', () => {
        expect(route({ risk: assessed(true), requested: 'balanced' })).toBe(
            'balanced',
        );
        expect(route({ risk: assessed(false), requested: 'heavy' })).toBe(
            'heavy',
        );
    });
    it('enforces the Heavy plan gate even for commands and routing', () => {
        expect(route({ risk: assessed(true), heavyAllowed: false })).toBe(
            'balanced',
        );
        expect(route({ requested: 'heavy', heavyAllowed: false })).toBe(
            'balanced',
        );
        expect(route({ configured: 'heavy', heavyAllowed: false })).toBe(
            'balanced',
        );
    });
    it('preserves CLI fast and legacy deep mode without assessment', () => {
        expect(
            route({
                configured: 'fast',
                requested: 'heavy',
                risk: assessed(true),
            }),
        ).toBe('fast');
        expect(route({ configured: 'deep' })).toBe('deep');
    });
});

describe('isHeavyReview', () => {
    it('follows the mode in settings when the command asks for none', () => {
        expect(isHeavyReview(undefined, 'heavy')).toBe(true);
        expect(isHeavyReview(undefined, 'balanced')).toBe(false);
        expect(isHeavyReview(undefined, undefined)).toBe(false);
    });

    it('lets the command override the mode in settings both ways', () => {
        expect(isHeavyReview('heavy', 'balanced')).toBe(true);
        expect(isHeavyReview('balanced', 'heavy')).toBe(false);
    });

    it('never runs a fast review heavy', () => {
        expect(isHeavyReview('heavy', 'fast')).toBe(false);
        expect(isHeavyReview(undefined, 'fast')).toBe(false);
    });
});

describe('agentReviewMode', () => {
    it('runs the agents of a heavy review as a balanced one', () => {
        expect(agentReviewMode('heavy')).toBe('balanced');
        expect(agentReviewMode('balanced')).toBe('balanced');
        expect(agentReviewMode(undefined)).toBe('balanced');
    });

    it('reads a legacy normal as balanced and keeps fast and deep', () => {
        expect(agentReviewMode('normal')).toBe('balanced');
        expect(agentReviewMode('fast')).toBe('fast');
        expect(agentReviewMode('deep')).toBe('deep');
    });
});

describe('reviewModeOfExecution', () => {
    const reviewed = { lastAnalyzedCommit: { sha: 'abc' } };

    it('reads the stored mode', () => {
        expect(
            reviewModeOfExecution({ ...reviewed, reviewMode: 'heavy' }),
        ).toBe('heavy');
        expect(
            reviewModeOfExecution({
                ...reviewed,
                reviewMode: 'balanced',
                heavy: false,
            }),
        ).toBe('balanced');
    });

    it('reads the heavy flag of an execution stored before the mode', () => {
        expect(reviewModeOfExecution({ ...reviewed, heavy: true })).toBe(
            'heavy',
        );
    });

    it('reads an older execution with no mark as balanced', () => {
        expect(reviewModeOfExecution(reviewed)).toBe('balanced');
    });

    it('has no mode for an execution that reviewed nothing', () => {
        expect(reviewModeOfExecution({ heavy: true })).toBeUndefined();
        expect(
            reviewModeOfExecution({ lastAnalyzedCommit: {} }),
        ).toBeUndefined();
        expect(reviewModeOfExecution(undefined)).toBeUndefined();
    });
});

describe('ultra mode', () => {
    it("routes risk to Ultra when the team set it, the gate being the caller's", () => {
        const routing = { noRisk: 'heavy', riskFound: 'ultra' } as const;
        const snapshot = {
            organizationId: 'org',
            repositoryId: 'repo',
            prNumber: 5,
            baseSha: 'base',
            headSha: 'head',
            assessmentKey: 'key',
        };
        expect(
            resolveRiskReviewMode({
                currentHeadSha: 'head',
                heavyAllowed: false,
                routing,
                risk: {
                    status: 'assessed',
                    riskIdentified: true,
                    reason: 'Evidence.',
                    snapshot,
                },
            }),
        ).toBe('ultra');
    });

    it('is asked by the command over settings, never on a fast review', () => {
        expect(isUltraReview('ultra', 'balanced')).toBe(true);
        expect(isUltraReview(undefined, 'ultra')).toBe(true);
        expect(isUltraReview('heavy', 'ultra')).toBe(false);
        expect(isUltraReview(undefined, 'fast')).toBe(false);
    });

    it('is not a heavy review: its runs route their own models', () => {
        expect(isHeavyReview('ultra', 'balanced')).toBe(false);
        expect(isHeavyReview(undefined, 'ultra')).toBe(false);
    });

    it('reads an Ultra execution as ultra on the Pull Requests screen', () => {
        expect(
            reviewModeOfExecution({
                lastAnalyzedCommit: { sha: 'abc' },
                reviewMode: 'ultra',
            }),
        ).toBe('ultra');
    });
});

describe('lastReviewModeOf', () => {
    it('reads the stored mode, then the heavy flag, then balanced', () => {
        expect(lastReviewModeOf({ reviewMode: 'ultra' })).toBe('ultra');
        expect(lastReviewModeOf({ reviewMode: 'heavy' })).toBe('heavy');
        expect(lastReviewModeOf({ heavy: true })).toBe('heavy');
        expect(lastReviewModeOf({})).toBe('balanced');
        expect(lastReviewModeOf(undefined)).toBe('balanced');
    });
});
