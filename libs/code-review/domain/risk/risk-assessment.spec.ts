import {
    hasConfirmedRisk,
    matchesRiskSnapshot,
    riskApprovalVeto,
    type RiskAssessmentResult,
    type RiskSnapshot,
} from './risk-assessment';

export const snapshot: RiskSnapshot = {
    organizationId: 'org',
    repositoryId: 'repo',
    prNumber: 5,
    baseSha: 'base',
    headSha: 'head',
    assessmentKey: 'config-and-diff',
};

const assessed = (riskIdentified: boolean): RiskAssessmentResult => ({
    status: 'assessed',
    riskIdentified,
    reason: 'Assessment reason.',
    snapshot,
});

describe('shared PR risk contract', () => {
    it.each([
        undefined,
        { status: 'disabled' },
        { status: 'unavailable', reason: 'Timeout.' },
        assessed(false),
    ] as const)('never treats %j as confirmed risk', (risk) => {
        expect(hasConfirmedRisk(risk)).toBe(false);
    });

    it('requires a successful positive judgment to confirm risk', () => {
        expect(hasConfirmedRisk(assessed(true))).toBe(true);
    });

    it.each(Object.keys(snapshot) as Array<keyof RiskSnapshot>)(
        'invalidates reuse when %s changes',
        (key) => {
            const other = {
                ...snapshot,
                [key]: key === 'prNumber' ? 6 : 'changed',
            };
            expect(matchesRiskSnapshot(assessed(false), other)).toBe(false);
        },
    );

    it('reuses only a successful judgment on the complete same snapshot', () => {
        expect(matchesRiskSnapshot(assessed(false), { ...snapshot })).toBe(
            true,
        );
        expect(
            matchesRiskSnapshot(
                { status: 'unavailable', reason: 'Failed.', snapshot },
                snapshot,
            ),
        ).toBe(false);
    });

    it.each([
        undefined,
        { status: 'disabled' },
        { status: 'unavailable', reason: 'Failed.' },
        assessed(true),
    ] as const)('vetoes approval for %j when assessment is enabled', (risk) => {
        expect(riskApprovalVeto(true, risk, 'head')).toBeDefined();
    });

    it('requires verified no-risk on the reviewed head for approval', () => {
        expect(riskApprovalVeto(true, assessed(false), 'head')).toBeUndefined();
        expect(
            riskApprovalVeto(true, assessed(false), 'new-head'),
        ).toBeDefined();
        expect(riskApprovalVeto(true, assessed(false), '')).toBeDefined();
    });

    it('removes only the risk veto when the engine is switched off', () => {
        expect(riskApprovalVeto(false, assessed(true), 'head')).toBeUndefined();
        expect(riskApprovalVeto(false, undefined, 'head')).toBeUndefined();
    });
});
