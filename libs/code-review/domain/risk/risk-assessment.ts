import { prRiskDescriptionKey } from './risk-configuration';
import { publicName } from '../public-name';

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
          /** The risk rules the change fell under; names come from config. */
          rules?: Array<{ id: string; name: string }>;
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
              code?: 'diff_too_large';
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

interface CurrentRiskSnapshot {
    headSha: string | undefined;
    baseSha: string | undefined;
    description: { title?: string; body?: string } | undefined;
}

/** Compare the PR fields available to a consumer after the assessment runs. */
export function riskSnapshotMismatch(
    risk: RiskAssessmentResult | undefined,
    current: CurrentRiskSnapshot,
): string | undefined {
    if (
        risk?.status !== 'assessed' ||
        !current.headSha ||
        risk.snapshot?.headSha !== current.headSha
    ) {
        return 'Risk assessment is unavailable for the current PR head.';
    }
    if (!current.baseSha?.trim() || risk.snapshot.baseSha !== current.baseSha)
        return 'Risk assessment is unavailable for the current PR base.';
    if (!current.description || !risk.snapshot.descriptionKey)
        return 'Risk assessment is unavailable for the current PR context.';
    if (
        risk.snapshot.descriptionKey !==
        prRiskDescriptionKey(current.description)
    )
        return 'The PR title or description changed after risk assessment.';
    return undefined;
}

/**
 * Names the rules that held the PR, so the team knows what to change; never
 * the model's rationale (#2400).
 */
function riskFoundReason(risk: RiskAssessmentResult | undefined): string {
    const names =
        risk?.status === 'assessed'
            ? [...new Set((risk.rules ?? []).map((rule) => rule.name))]
            : [];
    return names.length
        ? `Risk rule${names.length > 1 ? 's' : ''}: ${names.map(publicName).join(', ')}.`
        : 'Risk was identified in this PR.';
}

/** Approval is a consumer: enabling risk makes a verified no-risk result mandatory. */
export function riskApprovalVeto(
    riskEnabled: boolean,
    risk: RiskAssessmentResult | undefined,
    current: CurrentRiskSnapshot,
): string | undefined {
    if (!riskEnabled) return undefined;
    // Unavailable reasons are Kody's own text (at most a quoted file path),
    // never model or provider prose; without one every hold reads like an outage.
    if (risk?.status === 'unavailable')
        return `Risk assessment is unavailable: ${risk.reason}`;
    return (
        riskSnapshotMismatch(risk, current) ??
        (hasConfirmedRisk(risk) ? riskFoundReason(risk) : undefined)
    );
}
