import {
    agentReviewMode,
    isHeavyReview,
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
