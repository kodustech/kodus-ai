import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import { ParametersKey } from '@libs/core/domain/enums';
import { SummaryConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { PreviewPrSummaryDto } from '@libs/organization/dtos/preview-pr-summary.dto';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class PreviewPrSummaryUseCase {
    constructor(
        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private readonly commentManagerService: ICommentManagerService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly codeManagementService: CodeManagementService,
    ) {}

    async execute(body: PreviewPrSummaryDto & { organizationId: string }) {
        const {
            prNumber,
            repository,
            organizationId,
            teamId,
            behaviourForExistingDescription,
            customInstructions,
        } = body;

        const organizationAndTeamData = {
            organizationId,
            teamId,
        };

        const pullRequest =
            await this.codeManagementService.getPullRequestByNumber({
                organizationAndTeamData,
                repository,
                prNumber: Number(prNumber),
            });

        if (!pullRequest) {
            throw new NotFoundException('Pull request not found');
        }

        const prFiles =
            await this.codeManagementService.getFilesByPullRequestId({
                organizationAndTeamData,
                repository,
                prNumber: Number(prNumber),
            });

        if (!prFiles?.length) {
            throw new NotFoundException('Pull request not found');
        }

        const files = prFiles.map((file) => ({
            filename: file.filename,
            patch: file.patch,
            status: file.status,
        }));

        const languageResultPrompt = await this.parametersService.findByKey(
            ParametersKey.LANGUAGE_CONFIG,
            organizationAndTeamData,
        );

        const summaryConfig: SummaryConfig = {
            behaviourForExistingDescription: behaviourForExistingDescription,
            customInstructions: customInstructions,
            generatePRSummary: true,
        };

        // Resolve the platform so the prompt can hint the per-platform
        // PR-description size limit. Failure to resolve isn't fatal —
        // the soft hint just gets skipped and `fitPRDescription` still
        // truncates at the adapter boundary if needed.
        const platformType =
            await this.codeManagementService.getTypeIntegration(
                organizationAndTeamData,
            );

        const prSummary = await this.commentManagerService.generateSummaryPR(
            pullRequest,
            repository,
            files,
            organizationAndTeamData,
            languageResultPrompt?.configValue ?? 'en-US',
            summaryConfig,
            null,
            false,
            true,
            undefined,
            platformType ?? undefined,
        );

        return prSummary;
    }
}
