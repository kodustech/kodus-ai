import { SummaryConfig } from '@/config/types/general/codeReview.type';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '@/core/domain/codeBase/contracts/CommentManagerService.contract';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { PreviewPrSummaryDto } from '@/core/infrastructure/http/dtos/preview-pr-summary.dto';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
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
        );

        return prSummary;
    }
}
