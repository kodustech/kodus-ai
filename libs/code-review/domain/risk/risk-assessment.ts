import { prRiskDescriptionKey } from './risk-configuration';

/** A risk judgment belongs to one repository, PR, diff and configuration. */
export interface RiskSnapshot {
    organizationId: string;
    repositoryId: string;
    prNumber: number;
    baseSha: string;
    headSha: string;
    /** Includes assessment configuration, model and complete diff identity. */
    assessmentKey: string;
    /** Separate from diff/history identity, for live configuration checks in the approval cron. */
    configurationKey?: string;
    descriptionKey?: string;
}

export type RiskAssessmentResult =
    | { status: 'disabled' }
    | {
          status: 'assessed';
          riskIdentified: boolean;
          reason: string;
          snapshot: RiskSnapshot;
          areaMapVersion?: string;
      }
    | {
          status: 'unavailable';
          reason: string;
          snapshot?: RiskSnapshot;
          /** A routine outcome, such as a push during the diff read: not a failure. */
          expected?: true;
          failure?: {
              category: string;
              errorName: string;
              httpStatus?: number;
          };
      };

/** Missing, failed or disabled assessment never confirms a risk condition. */
export function hasConfirmedRisk(
    risk: RiskAssessmentResult | undefined,
): boolean {
    return risk?.status === 'assessed' && risk.riskIdentified;
}

function isStoredAssessment(
    risk: Partial<RiskAssessmentResult> | undefined,
): risk is Extract<RiskAssessmentResult, { status: 'assessed' }> {
    return (
        risk?.status === 'assessed' &&
        typeof risk.riskIdentified === 'boolean' &&
        typeof risk.reason === 'string' &&
        !!risk.reason.trim() &&
        !!risk.snapshot
    );
}

/** Persisted executions may predate snapshot fields; they are not output-schema validated on read. */
export function isCurrentRiskAssessment(
    risk: Partial<RiskAssessmentResult> | undefined,
    expected: Omit<RiskSnapshot, 'assessmentKey' | 'configurationKey'> & {
        configurationKey: string;
    },
): boolean {
    return (
        isStoredAssessment(risk) &&
        !!expected.baseSha &&
        !!expected.headSha &&
        !!expected.configurationKey &&
        !!risk.snapshot.configurationKey &&
        Object.entries(expected).every(
            ([key, value]) => risk.snapshot[key] === value,
        )
    );
}

/** Only an assessment of the current snapshot is reusable. */
export function matchesRiskSnapshot(
    risk: Partial<RiskAssessmentResult> | undefined,
    snapshot: RiskSnapshot,
): boolean {
    if (!isStoredAssessment(risk)) return false;
    return (Object.keys(snapshot) as Array<keyof RiskSnapshot>).every(
        (key) => risk.snapshot[key] === snapshot[key],
    );
}

/** Approval is a consumer: enabling risk makes a verified no-risk result mandatory. */
export function riskApprovalVeto(
    riskEnabled: boolean,
    risk: RiskAssessmentResult | undefined,
    currentHeadSha: string,
    currentDescription?: { title?: string; body?: string },
): string | undefined {
    if (!riskEnabled) return undefined;
    if (
        risk?.status !== 'assessed' ||
        !currentHeadSha ||
        risk.snapshot.headSha !== currentHeadSha
    ) {
        return 'Risk assessment is unavailable for the current PR head.';
    }
    if (currentDescription && !risk.snapshot.descriptionKey)
        return 'Risk assessment is unavailable for the current PR context.';
    if (
        currentDescription &&
        risk.snapshot.descriptionKey !==
            prRiskDescriptionKey(currentDescription)
    )
        return 'The PR title or description changed after risk assessment.';
    return risk.riskIdentified ? 'Risk was identified in this PR.' : undefined;
}
