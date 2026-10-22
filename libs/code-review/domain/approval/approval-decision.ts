import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import type { CodeReviewConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';

export interface ApprovalPolicy {
    /** Any configured label matches. When authors are also set, both groups apply. */
    labels?: string[];
    /** Provider login, compared without case. */
    authors?: string[];
    assessRisk?: boolean;
    riskInstructions?: string;
    /** Team policy marks; these veto approval independently of the risk model. */
    sensitivePaths?: string[];
}

export type ApprovalRiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export interface ApprovalRiskAssessment {
    level: ApprovalRiskLevel;
    reason: string;
    reviewedHeadSha: string;
    areaMapVersion?: string;
}

export interface ApprovalDecision {
    kind: 'approve' | 'hold' | 'out-of-scope' | 'disabled';
    reason: string;
}

const normalized = (value: string) => value.trim().toLocaleLowerCase('en-US');

export function approvalPolicyFromConfig(
    config: CodeReviewConfig,
): ApprovalPolicy {
    return {
        labels: config.approvalLabels,
        authors: config.approvalAuthors,
        assessRisk: config.approvalRiskActive,
        riskInstructions: config.approvalRiskInstructions,
        sensitivePaths: config.approvalSensitivePaths,
    };
}

export function matchesApprovalScope(input: {
    policy?: ApprovalPolicy;
    author?: string;
    labels?: string[];
}): { matches: boolean; reason?: string } {
    const labels = new Set(
        (input.policy?.labels ?? []).map(normalized).filter(Boolean),
    );
    const authors = (input.policy?.authors ?? [])
        .map(normalized)
        .filter(Boolean);
    if (
        labels.size > 0 &&
        !(input.labels ?? []).some((label) => labels.has(normalized(label)))
    ) {
        return {
            matches: false,
            reason: 'The PR does not carry a configured approval label.',
        };
    }
    if (
        authors.length > 0 &&
        !authors.includes(normalized(input.author ?? ''))
    ) {
        return {
            matches: false,
            reason: 'The PR author is outside the approval scope.',
        };
    }
    return { matches: true };
}

export function evaluateApproval(input: {
    approvalActive: boolean;
    policy?: ApprovalPolicy;
    author?: string;
    labels?: string[];
    changedPaths?: string[];
    reviewClean: boolean;
    risk?: ApprovalRiskAssessment;
    currentHeadSha?: string;
}): ApprovalDecision {
    if (!input.approvalActive) {
        return { kind: 'disabled', reason: 'Automatic approval is disabled.' };
    }
    if (!input.reviewClean) {
        return { kind: 'hold', reason: 'The review is not clean.' };
    }

    const policy = input.policy;
    const scope = matchesApprovalScope(input);
    if (!scope.matches) {
        return {
            kind: 'out-of-scope',
            reason: scope.reason ?? 'The PR is outside the approval scope.',
        };
    }
    const matchingSensitivePath = (input.changedPaths ?? []).find((path) =>
        (policy?.sensitivePaths ?? []).some((pattern) =>
            isFileMatchingGlob(path, [pattern]),
        ),
    );
    if (matchingSensitivePath) {
        return {
            kind: 'hold',
            reason: `The PR changes a team-marked sensitive path: ${matchingSensitivePath}.`,
        };
    }
    if (!policy?.assessRisk) {
        return {
            kind: 'approve',
            reason: 'The review is clean and the PR matches the approval scope.',
        };
    }
    if (
        !input.risk ||
        !input.currentHeadSha ||
        input.risk.reviewedHeadSha !== input.currentHeadSha ||
        input.risk.level === 'unknown'
    ) {
        return {
            kind: 'hold',
            reason: 'Kody could not assess risk for the current PR head.',
        };
    }
    if (input.risk.level !== 'low') {
        return {
            kind: 'hold',
            reason: input.risk.reason || 'The PR needs a human risk review.',
        };
    }
    return {
        kind: 'approve',
        reason: input.risk.reason || 'Kody assessed low risk for this PR.',
    };
}
