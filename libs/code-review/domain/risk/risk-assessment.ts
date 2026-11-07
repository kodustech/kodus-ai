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

/** The approval cron rechecks configuration and provider identity without another model call. */
export function isCurrentRiskAssessment(
    risk: RiskAssessmentResult | undefined,
    expected: Omit<RiskSnapshot, 'assessmentKey' | 'configurationKey'> & {
        configurationKey: string;
    },
): boolean {
    return (
        risk?.status === 'assessed' &&
        !!expected.baseSha &&
        !!expected.headSha &&
        !!expected.configurationKey &&
        !!risk.snapshot?.configurationKey &&
        Object.entries(expected).every(
            ([key, value]) => risk.snapshot[key] === value,
        )
    );
}

/** Only an assessment of the current snapshot is reusable. */
export function matchesRiskSnapshot(
    risk: RiskAssessmentResult | undefined,
    snapshot: RiskSnapshot,
): boolean {
    if (risk?.status !== 'assessed' || !risk.snapshot) return false;
    return (Object.keys(snapshot) as Array<keyof RiskSnapshot>).every(
        (key) => risk.snapshot[key] === snapshot[key],
    );
}

/** Approval is a consumer: enabling risk makes a verified no-risk result mandatory. */
export function riskApprovalVeto(
    riskEnabled: boolean,
    risk: RiskAssessmentResult | undefined,
    currentHeadSha: string,
): string | undefined {
    if (!riskEnabled) return undefined;
    if (
        risk?.status !== 'assessed' ||
        !currentHeadSha ||
        risk.snapshot.headSha !== currentHeadSha
    ) {
        return 'Risk assessment is unavailable for the current PR head.';
    }
    return risk.riskIdentified ? 'Risk was identified in this PR.' : undefined;
}
