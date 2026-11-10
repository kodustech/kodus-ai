import { Inject, Injectable } from '@nestjs/common';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import type {
    CodeReviewConfig,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
    type IOrganizationParametersService,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import {
    CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN,
    type IConditionalApprovalAccessService,
} from '@libs/code-review/domain/approval/conditional-approval-access.contract';
import {
    evaluateApprovalPolicies,
    approvalPoliciesFromConfig,
    type PolicyEligibility,
} from '@libs/code-review/domain/approval/approval-policies';
import {
    assessPolicyEligibility,
    policyEligibilityKey,
    type PolicyEligibilityInput,
} from '@libs/code-review/domain/approval/assess-policy-eligibility';
import type { ApprovalDecision } from '@libs/code-review/domain/approval/approval-decision';
import { approvalPrMetadataKey } from '@libs/code-review/domain/approval/approval-pr-metadata';
import {
    riskApprovalVeto,
    type RiskAssessmentResult,
} from '@libs/code-review/domain/risk/risk-assessment';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { routeCodeReviewModel } from '../stages/route-code-review-model';

export type ApprovalEligibilityCache = Record<string, PolicyEligibility>;

export interface ApprovalPoliciesRequest {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: { id: string; name: string };
    pullRequest: {
        number: number;
        head?: { sha?: string };
        base?: { sha?: string };
        stats?: { total_files: number };
    };
    config: CodeReviewConfig;
    platformType: PlatformType;
    reviewClean: boolean;
    risk?: RiskAssessmentResult;
    fullPrFiles?: FileChange[];
    heavy?: boolean;
    previousEligibility?: ApprovalEligibilityCache;
}

@Injectable()
export class ApprovalPoliciesService {
    constructor(
        private readonly codeManagement: CodeManagementService,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParameters: IOrganizationParametersService,
        @Inject(CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN)
        private readonly access: IConditionalApprovalAccessService,
        private readonly permissions: PermissionValidationService,
    ) {}

    async evaluate(input: ApprovalPoliciesRequest): Promise<{
        decision: ApprovalDecision;
        eligibility: ApprovalEligibilityCache;
    }> {
        const eligibility: ApprovalEligibilityCache = {};
        const headSha = input.pullRequest.head?.sha ?? '';
        const baseSha = input.pullRequest.base?.sha ?? '';
        const hold = (reason: string) => ({
            decision: {
                kind: 'hold' as const,
                reason,
                reviewedHeadSha: headSha,
                reviewedBaseSha: baseSha,
            },
            eligibility,
        });
        if (!input.config.pullRequestApprovalActive)
            return {
                decision: {
                    kind: 'disabled',
                    reason: 'Automatic approval is disabled.',
                },
                eligibility,
            };
        if (input.config.reviewSettingsError)
            return hold(input.config.reviewSettingsError);
        if (!input.reviewClean)
            return hold('The review is not clean or did not complete.');
        const riskVeto = riskApprovalVeto(
            input.config.riskAssessmentActive === true,
            input.risk,
            headSha,
        );
        if (riskVeto) return hold(riskVeto);
        if (
            !headSha ||
            !baseSha ||
            !input.organizationAndTeamData.organizationId
        )
            return hold('The reviewed PR snapshot could not be verified.');
        try {
            // Bitbucket never applied legacy approvalLabels. Preserve migrated
            // behavior; the settings writer rejects every new canonical label condition.
            const policies = approvalPoliciesFromConfig(input.config).map(
                (policy) =>
                    input.platformType === PlatformType.BITBUCKET &&
                    policy.id === 'legacy-approval'
                        ? { ...policy, labels: [] }
                        : policy,
            );
            const enabled = policies.filter((policy) => policy.enabled);
            const advanced =
                enabled.length > 1 ||
                !!input.config.approvalSensitivePaths?.length ||
                enabled.some(
                    (policy) =>
                        policy.labels?.length ||
                        policy.authors?.length ||
                        policy.authorTeams?.length ||
                        policy.includedFiles?.length ||
                        policy.excludedFiles?.length ||
                        policy.maxChangedLines !== undefined ||
                        policy.instruction?.trim(),
                );
            if (
                advanced &&
                !(await this.access.isEnabled(input.organizationAndTeamData))
            )
                return hold(
                    'Approval policies are unavailable for this organization.',
                );
            const request = {
                organizationAndTeamData: input.organizationAndTeamData,
                repository: input.repository,
                prNumber: input.pullRequest.number,
            };
            const live = await this.codeManagement.getPullRequest({
                ...request,
                includeLabels: true,
            });
            if (live?.head?.sha !== headSha || live?.base?.sha !== baseSha)
                return hold('The PR changed after it was reviewed.');
            const needsFiles =
                policies.some(
                    (policy) =>
                        policy.enabled &&
                        (policy.includedFiles?.length ||
                            policy.excludedFiles?.length ||
                            policy.maxChangedLines !== undefined ||
                            policy.instruction?.trim()),
                ) || !!input.config.approvalSensitivePaths?.length;
            const files = needsFiles
                ? (input.fullPrFiles ??
                  (await this.codeManagement.getFilesByPullRequestId({
                      ...request,
                      headSha,
                  })))
                : [];
            // The host's file API must return a complete listing. Pipeline
            // stats count analysed files after ignore/deletion filtering.
            if (
                needsFiles &&
                (!files?.length || files.some((file) => !file.filename))
            )
                return hold('The complete PR file list could not be verified.');
            let modelLoaded = false;
            let modelSlot: NormalizedModel | undefined;
            let modelAvailable = true;
            const judgeEligibility = async (
                policy: PolicyEligibilityInput['policy'],
            ): Promise<PolicyEligibility> => {
                if (!modelLoaded) {
                    if (input.config.resolvedModelSlot)
                        modelSlot = input.config.resolvedModelSlot;
                    else {
                        const stored =
                            await this.organizationParameters.findByKey(
                                OrganizationParametersKey.BYOK_CONFIG,
                                input.organizationAndTeamData,
                            );
                        const resolution = routeCodeReviewModel(
                            stored?.configValue,
                            input.config,
                            input.heavy,
                        );
                        modelSlot = resolution.resolvedModelSlot;
                        modelAvailable = !resolution.blocked;
                    }
                    modelLoaded = true;
                }
                if (!modelAvailable) return { status: 'unavailable' };
                const judgmentInput: PolicyEligibilityInput = {
                    organizationId:
                        input.organizationAndTeamData.organizationId,
                    repositoryId: input.repository.id,
                    prNumber: input.pullRequest.number,
                    headSha,
                    baseSha,
                    title: live.title,
                    body: live.body,
                    author: live.user?.login,
                    labels: live.labels,
                    files,
                    policy,
                    modelSlot,
                };
                const key = policyEligibilityKey(judgmentInput);
                const cached = input.previousEligibility?.[key];
                if (
                    cached?.key === key &&
                    ['eligible', 'ineligible'].includes(cached.status)
                ) {
                    eligibility[key] = cached;
                    return cached;
                }
                if (
                    await this.permissions.gateKodusCreditsForSlot(
                        modelSlot,
                        input.organizationAndTeamData,
                        'ApprovalPoliciesService',
                    )
                )
                    return { status: 'unavailable', key };
                const result = await assessPolicyEligibility(judgmentInput);
                eligibility[key] = result;
                return result;
            };
            const decision = await evaluateApprovalPolicies({
                approvalActive: true,
                policies,
                reviewClean: input.reviewClean,
                riskEnabled: input.config.riskAssessmentActive === true,
                risk: input.risk,
                currentHeadSha: headSha,
                platformType: input.platformType,
                author: live.user?.login,
                labels: live.labels,
                files,
                sensitivePaths: input.config.approvalSensitivePaths,
                resolveTeamMembership: (team, author) =>
                    this.codeManagement.getApprovalTeamMembership({
                        organizationAndTeamData: input.organizationAndTeamData,
                        repository: input.repository,
                        team,
                        author,
                    }),
                judgeEligibility,
            });
            // A provider read or model call can race a new commit or base update.
            if (decision.kind === 'approve') {
                const current = await this.codeManagement.getPullRequest({
                    ...request,
                    includeLabels: true,
                });
                if (
                    current?.head?.sha !== headSha ||
                    current?.base?.sha !== baseSha ||
                    approvalPrMetadataKey(current) !==
                        approvalPrMetadataKey(live)
                )
                    return hold(
                        'The PR changed while approval conditions were evaluated.',
                    );
            }
            return {
                decision: {
                    ...decision,
                    reviewedHeadSha: headSha,
                    reviewedBaseSha: baseSha,
                    reviewedMetadataKey: approvalPrMetadataKey(live),
                },
                eligibility,
            };
        } catch {
            return hold('Approval conditions could not be verified.');
        }
    }
}
