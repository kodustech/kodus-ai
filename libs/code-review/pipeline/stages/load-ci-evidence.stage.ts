import { Injectable } from '@nestjs/common';

import {
    ManagedTool,
    isToolCoveredByCi,
} from '@libs/code-review/infrastructure/adapters/services/ci-evidence/recognize-ci-analyzers';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { createLogger } from '@libs/core/log/logger';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * Reads the CI results the customer's own pipeline already produced for the
 * head commit, so the review can use them as evidence instead of rediscovering
 * what a deterministic tool has proven — and so we can skip running an
 * analyzer their pipeline already runs.
 *
 * Everything here is best-effort. The facade never throws, and the guards
 * below cover the cases where there is simply nothing to address.
 */
@Injectable()
export class LoadCiEvidenceStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'LoadCiEvidenceStage';
    readonly label = 'Reading CI Results';
    readonly visibility = StageVisibility.SECONDARY;

    private readonly logger = createLogger(LoadCiEvidenceStage.name);

    constructor(private readonly codeManagementService: CodeManagementService) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (
            context.codeReviewConfig?.deterministicEvidence?.ciChecks !== true
        ) {
            return context;
        }

        const commitSha = context.pullRequest?.head?.sha;
        if (!commitSha) {
            return context;
        }

        const target = this.resolveRepository(context);
        if (!target) {
            return context;
        }

        let evidence;
        try {
            evidence = await this.codeManagementService.getCheckEvidence({
                organizationAndTeamData: context.organizationAndTeamData,
                repository: target,
                commitSha,
                prNumber: context.pullRequest?.number,
                includeAnnotations: true,
            });
        } catch (error) {
            this.logger.warn({
                message: 'Failed to load CI check evidence',
                context: this.stageName,
                error,
                metadata: { repository: target.name, commitSha },
            });
            return context;
        }

        if (!evidence?.length) {
            return context;
        }

        const coveredTools = Object.values(ManagedTool).filter((tool) =>
            isToolCoveredByCi(tool, evidence),
        );

        this.logger.log({
            message: `Read ${evidence.length} CI checks for ${target.name}`,
            context: this.stageName,
            metadata: {
                commitSha,
                checkCount: evidence.length,
                coveredTools,
            },
        });

        return this.updateContext(context, (draft) => {
            draft.ciEvidence = evidence;
            draft.ciCoveredTools = coveredTools;
        });
    }

    /**
     * Splits `fullName` on the LAST slash: GitLab projects can live under
     * nested groups ("group/subgroup/project"), where only the final segment
     * is the repository and everything before it is the owner path.
     */
    private resolveRepository(
        context: CodeReviewPipelineContext,
    ): { owner: string; name: string; id?: string } | null {
        const fullName =
            context.repository?.fullName ||
            context.pullRequest?.base?.repo?.fullName;

        const separator = fullName?.lastIndexOf('/') ?? -1;
        if (!fullName || separator <= 0) {
            return null;
        }

        return {
            owner: fullName.slice(0, separator),
            name: fullName.slice(separator + 1),
            id: context.repository?.id,
        };
    }
}
