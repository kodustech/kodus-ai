import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    approvalPoliciesSchema,
    type NamedApprovalPolicy,
} from '@libs/core/infrastructure/config/types/general/approval-policies';
import type { CodeReviewConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    riskApprovalVeto,
    type RiskAssessmentResult,
} from '../risk/risk-assessment';
import { approvalPathsOf, type ApprovalDecision } from './approval-decision';
import {
    evaluateApprovalFileConditions,
    type ApprovalChangedFile,
} from './approval-file-conditions';

export type PolicyReason =
    | 'matched'
    | 'disabled'
    | 'global-veto'
    | 'labels-mismatch'
    | 'labels-unavailable'
    | 'author-mismatch'
    | 'author-unavailable'
    | 'files-unavailable'
    | 'outside-included-files'
    | 'excluded-file'
    | 'line-count-unavailable'
    | 'line-limit-exceeded'
    | 'instruction-mismatch'
    | 'instruction-unavailable'
    | 'earlier-policy-matched';

export interface ApprovalPolicyResult {
    policyId: string;
    policyName: string;
    status:
        | 'matched'
        | 'not-matched'
        | 'unavailable'
        | 'disabled'
        | 'not-evaluated';
    reason: PolicyReason;
}

export interface PolicyEligibility {
    status: 'eligible' | 'ineligible' | 'unavailable';
    /** Persisted identity for reuse on this exact PR/configuration. */
    key?: string;
}

export type TeamMembership = 'member' | 'not-member' | 'unavailable';

export interface ApprovalPolicyInput {
    approvalActive: boolean;
    policies: NamedApprovalPolicy[];
    reviewClean: boolean;
    riskEnabled: boolean;
    risk?: RiskAssessmentResult;
    currentHeadSha: string;
    platformType?: PlatformType;
    author?: string;
    labels?: string[];
    files?: readonly ApprovalChangedFile[];
    sensitivePaths?: string[];
    resolveTeamMembership?: (
        team: string,
        author: string,
    ) => Promise<TeamMembership>;
    judgeEligibility?: (
        policy: NamedApprovalPolicy,
    ) => Promise<PolicyEligibility>;
}

const normalize = (value: string) => value.trim().toLocaleLowerCase('en-US');

/** Missing policies migrate the old single scope; an explicit empty list stays empty. */
export function approvalPoliciesFromConfig(
    config: Pick<
        CodeReviewConfig,
        'approvalPolicies' | 'approvalLabels' | 'approvalAuthors'
    >,
): NamedApprovalPolicy[] {
    if (config.approvalPolicies !== undefined)
        return approvalPoliciesSchema.parse(config.approvalPolicies);
    return [
        {
            id: 'legacy-approval',
            name: 'Existing approval policy',
            enabled: true,
            labels: config.approvalLabels ?? [],
            authors: config.approvalAuthors ?? [],
        },
    ];
}

/** Public output uses condition categories, never saved filter values or LLM prose. */
export const policyReasonText: Record<PolicyReason, string> = {
    'matched': 'Matched.',
    'disabled': 'Disabled.',
    'global-veto': 'Approval requirements were not met.',
    'labels-mismatch': 'Required labels did not match.',
    'labels-unavailable': 'PR labels could not be verified.',
    'author-mismatch': 'The PR author did not match.',
    'author-unavailable': 'Team membership could not be verified.',
    'files-unavailable': 'The complete PR file list could not be verified.',
    'outside-included-files':
        'The PR changes files outside the included paths.',
    'excluded-file': 'The PR changes an excluded file.',
    'line-count-unavailable': 'Changed lines could not be verified.',
    'line-limit-exceeded': 'The changed-line limit was exceeded.',
    'instruction-mismatch': 'The eligibility instruction did not match.',
    'instruction-unavailable':
        'The eligibility instruction could not be evaluated.',
    'earlier-policy-matched': 'An earlier policy matched.',
};

const publicName = (name: string) =>
    name
        .replace(/[\r\n]/g, ' ')
        .replace(/[\\`*_[\]<>~|]/g, '\\$&')
        .replace(/@/g, '@\u200b');

async function fixedConditions(
    policy: NamedApprovalPolicy,
    input: ApprovalPolicyInput,
    membership: (team: string, author: string) => Promise<TeamMembership>,
): Promise<PolicyReason | undefined> {
    if (policy.labels?.length) {
        if (
            input.platformType === PlatformType.BITBUCKET ||
            !Array.isArray(input.labels)
        )
            return 'labels-unavailable';
        const labels = new Set(input.labels.map(normalize));
        if (!policy.labels.some((label) => labels.has(normalize(label))))
            return 'labels-mismatch';
    }
    if (policy.authors?.length || policy.authorTeams?.length) {
        const author = normalize(input.author ?? '');
        if (!author) return 'author-unavailable';
        if (
            !policy.authors?.some(
                (candidate) => normalize(candidate) === author,
            )
        ) {
            let unknown = false;
            let matched = false;
            for (const team of policy.authorTeams ?? []) {
                const result = await membership(team, author);
                if (result === 'member') {
                    matched = true;
                    break;
                }
                unknown ||= result === 'unavailable';
            }
            if (!matched)
                return unknown ? 'author-unavailable' : 'author-mismatch';
        }
    }
    const fileResult = evaluateApprovalFileConditions(policy, input.files);
    return 'code' in fileResult ? fileResult.code : undefined;
}

export async function evaluateApprovalPolicies(
    input: ApprovalPolicyInput,
): Promise<ApprovalDecision & { policies: ApprovalPolicyResult[] }> {
    let policies: NamedApprovalPolicy[];
    try {
        policies = approvalPoliciesSchema.parse(input.policies);
    } catch {
        return {
            kind: 'hold',
            reason: 'Approval policies are invalid.',
            policies: [],
        };
    }
    const results: ApprovalPolicyResult[] = policies.map((policy) => ({
        policyId: policy.id,
        policyName: policy.name,
        status: policy.enabled ? 'not-evaluated' : 'disabled',
        reason: policy.enabled ? 'global-veto' : 'disabled',
    }));
    const hold = (reason: string) => ({
        kind: 'hold' as const,
        reason,
        policies: results,
    });
    if (!input.approvalActive)
        return {
            kind: 'disabled',
            reason: 'Automatic approval is disabled.',
            policies: results,
        };
    if (!input.reviewClean)
        return hold('The review is not clean or did not complete.');
    const veto = riskApprovalVeto(
        input.riskEnabled,
        input.risk,
        input.currentHeadSha,
    );
    if (veto) return hold(veto);
    if (input.sensitivePaths?.length) {
        if (!input.files?.length || input.files.some((file) => !file.filename))
            return hold('The complete PR file list could not be verified.');
        if (
            approvalPathsOf([...input.files]).some((path) =>
                isFileMatchingGlob(path, input.sensitivePaths),
            )
        ) {
            return hold('The PR changes a file requiring human approval.');
        }
    }
    if (!policies.some((policy) => policy.enabled))
        return hold('No approval policies are enabled.');
    const membershipCache = new Map<string, Promise<TeamMembership>>();
    const membership = (team: string, author: string) => {
        const key = `${normalize(team)}\0${author}`;
        if (!membershipCache.has(key))
            membershipCache.set(
                key,
                input.resolveTeamMembership
                    ? Promise.resolve()
                          .then(() =>
                              input.resolveTeamMembership!(team, author),
                          )
                          .catch(() => 'unavailable')
                    : Promise.resolve('unavailable'),
            );
        return membershipCache.get(key)!;
    };
    // Check every policy's cheap conditions before any eligibility instruction.
    for (const [index, policy] of policies.entries()) {
        if (!policy.enabled) continue;
        const reason = await fixedConditions(policy, input, membership);
        if (reason) {
            results[index].reason = reason;
            results[index].status = reason.endsWith('unavailable')
                ? 'unavailable'
                : 'not-matched';
        } else results[index].reason = 'matched';
    }
    for (const [index, policy] of policies.entries()) {
        if (!policy.enabled || results[index].reason !== 'matched') continue;
        if (policy.instruction?.trim()) {
            let judgment: PolicyEligibility = { status: 'unavailable' };
            try {
                judgment = (await input.judgeEligibility?.(policy)) ?? judgment;
            } catch {
                /* No instruction result can authorize. */
            }
            if (judgment.status !== 'eligible') {
                results[index].status =
                    judgment.status === 'ineligible'
                        ? 'not-matched'
                        : 'unavailable';
                results[index].reason =
                    judgment.status === 'ineligible'
                        ? 'instruction-mismatch'
                        : 'instruction-unavailable';
                continue;
            }
        }
        results[index].status = 'matched';
        for (const later of results.slice(index + 1)) {
            if (later.status === 'not-evaluated' && later.reason === 'matched')
                later.reason = 'earlier-policy-matched';
        }
        return {
            kind: 'approve',
            reason: `Approved by policy “${publicName(policy.name)}”.`,
            matchedPolicy: { id: policy.id, name: policy.name },
            policies: results,
        };
    }
    return {
        kind: 'out-of-scope',
        reason: `No approval policy matched.\n${results
            .filter((result) => result.status !== 'disabled')
            .map(
                (result) =>
                    `- ${publicName(result.policyName)}: ${policyReasonText[result.reason]}`,
            )
            .join('\n')}`,
        policies: results,
    };
}
