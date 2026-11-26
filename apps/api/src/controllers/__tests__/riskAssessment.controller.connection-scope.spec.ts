import { DEFAULT_RISK_CRITERIA } from '@libs/code-review/domain/risk/default-risk-criteria';
import { RETIRED_KODUS_RISK_RULE_IDS } from '@libs/core/infrastructure/config/types/general/risk-rule-ids';

import { RiskAssessmentController } from '../riskAssessment.controller';

describe('RiskAssessmentController — reads by a member granted some Git connections', () => {
    it('marks the default criteria as a read that needs no narrowing', () => {
        expect(
            Reflect.getMetadata(
                'applies_connection_scope',
                RiskAssessmentController.prototype.defaultCriteria,
            ),
        ).toBe(true);
    });

    // Kodus's own criteria: the same for everyone, nothing of any connection.
    it("answers Kodus's default criteria and retired ids, and nothing else", () => {
        const controller = Object.create(RiskAssessmentController.prototype);

        expect(controller.defaultCriteria()).toEqual({
            criteria: DEFAULT_RISK_CRITERIA,
            retiredIds: RETIRED_KODUS_RISK_RULE_IDS,
        });
    });
});
