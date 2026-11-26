import { RiskAssessmentController } from '../riskAssessment.controller';

describe('RiskAssessmentController — reads by a member granted some Git connections', () => {
    // Kodus's own default criteria hold nothing of any connection, so the
    // guard may let them through to such a member.
    it('serves the default criteria as a read that needs no narrowing', () => {
        expect(
            Reflect.getMetadata(
                'applies_connection_scope',
                RiskAssessmentController.prototype.defaultCriteria,
            ),
        ).toBe(true);
    });
});
