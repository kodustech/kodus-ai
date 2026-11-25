// Compatibility adapter for the existing approval path. The evaluator belongs to risk.
export {
    assessChangeRisk as assessApprovalRisk,
    approvalRiskOutputSchema,
} from '../risk/assess-change-risk';
