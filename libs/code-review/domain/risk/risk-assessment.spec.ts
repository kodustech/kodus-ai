import {
    hasConfirmedRisk,
    matchesRiskSnapshot,
    riskApprovalVeto,
    riskSnapshotMismatch,
    type RiskAssessmentResult,
    type RiskSnapshot,
} from './risk-assessment';
import { prRiskDescriptionKey } from './risk-configuration';

export const snapshot: RiskSnapshot = {
    organizationId: 'org',
    repositoryId: 'repo',
    prNumber: 5,
    baseSha: 'base',
    headSha: 'head',
    assessmentKey: 'config-and-diff',
    descriptionKey: prRiskDescriptionKey({}),
};

const assessed = (
    riskIdentified: boolean,
): Extract<RiskAssessmentResult, { status: 'assessed' }> => ({
    status: 'assessed',
    riskIdentified,
    reason: 'Assessment reason.',
    snapshot,
});
const current = { headSha: 'head', baseSha: 'base', description: {} };

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

    it('does not reuse a persisted snapshot without a boolean judgment', () => {
        expect(
            matchesRiskSnapshot(
                { status: 'assessed', reason: 'Stored snapshot.', snapshot },
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
        expect(riskApprovalVeto(true, risk, current)).toBeDefined();
    });

    it('says why an unavailable assessment holds approval', () => {
        expect(
            riskApprovalVeto(
                true,
                {
                    status: 'unavailable',
                    reason: 'Kody could not read the diff of src/a.ts: the Git provider did not return it.',
                },
                current,
            ),
        ).toBe(
            'Risk assessment is unavailable: Kody could not read the diff of src/a.ts: the Git provider did not return it.',
        );
    });

    it('requires verified no-risk on the reviewed head for approval', () => {
        expect(
            riskApprovalVeto(true, assessed(false), current),
        ).toBeUndefined();
        expect(
            riskApprovalVeto(true, assessed(false), {
                ...current,
                headSha: 'new-head',
            }),
        ).toBeDefined();
        expect(
            riskApprovalVeto(true, assessed(false), {
                ...current,
                headSha: '',
            }),
        ).toBeDefined();
    });

    it('shares base and description checks between routing and approval', () => {
        const description = { title: 'Original', body: 'Context' };
        const result = {
            ...assessed(false),
            snapshot: {
                ...snapshot,
                descriptionKey: prRiskDescriptionKey(description),
            },
        } as RiskAssessmentResult;
        expect(
            riskSnapshotMismatch(result, {
                headSha: 'head',
                baseSha: 'base',
                description,
            }),
        ).toBeUndefined();
        const changes = [
            { baseSha: 'moved', description },
            {
                baseSha: 'base',
                description: { ...description, title: 'Edited' },
            },
        ];
        for (const { baseSha, description } of changes) {
            const mismatch = riskSnapshotMismatch(result, {
                headSha: 'head',
                baseSha,
                description,
            });
            expect(mismatch).toBeDefined();
            expect(
                riskApprovalVeto(true, result, {
                    headSha: 'head',
                    baseSha,
                    description,
                }),
            ).toBe(mismatch);
        }
    });

    it('removes only the risk veto when the engine is switched off', () => {
        expect(
            riskApprovalVeto(false, assessed(true), current),
        ).toBeUndefined();
        expect(riskApprovalVeto(false, undefined, current)).toBeUndefined();
    });

    it('holds an otherwise current assessment when the PR description was not read', () => {
        const identity = { ...current, description: undefined };
        expect(riskApprovalVeto(true, assessed(false), identity)).toBe(
            'Risk assessment is unavailable for the current PR context.',
        );
    });

    it.each([undefined, '', '   '])(
        'holds approval when the current base is %j',
        (baseSha) => {
            const identity = { ...current, baseSha };
            const result = assessed(false);
            // A persisted legacy snapshot can have the same unverified base.
            const unverified = {
                ...result,
                snapshot: { ...result.snapshot, baseSha: baseSha as string },
            };
            expect(riskSnapshotMismatch(unverified, identity)).toContain(
                'current PR base',
            );
            expect(riskApprovalVeto(true, unverified, identity)).toContain(
                'current PR base',
            );
        },
    );
});
