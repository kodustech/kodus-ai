import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { ParametersKey } from '@libs/core/domain/enums';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { riskCriteriaSchema } from '@libs/core/infrastructure/config/types/general/risk-assessment';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PrRiskAssessmentService } from '@libs/code-review/pipeline/services/pr-risk-assessment.service';

@Injectable()
export class PreviewPrRiskUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parameters: IParametersService,
        private readonly codeManagement: CodeManagementService,
        private readonly risk: PrRiskAssessmentService,
    ) {}

    async execute(input: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        prNumber: number;
        criteria?: unknown;
    }) {
        if (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1) {
            throw new BadRequestException('Enter a valid PR number.');
        }
        const criteria = riskCriteriaSchema.safeParse(input.criteria ?? []);
        if (!criteria.success)
            throw new BadRequestException('Risk criteria are invalid.');
        const parameter = await this.parameters.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            input.organizationAndTeamData,
        );
        // Resolve the named repository through this team's stored selection;
        // the caller cannot inject a repository name or arbitrary provider URL.
        const saved = parameter?.configValue?.repositories?.find(
            (repo) => repo.id === input.repositoryId,
        );
        if (!saved || saved.isSelected === false)
            throw new NotFoundException('Repository not found in this team.');
        const repository = { id: saved.id, name: saved.name };
        const pullRequest = await this.codeManagement.getPullRequestByNumber({
            organizationAndTeamData: input.organizationAndTeamData,
            repository,
            prNumber: input.prNumber,
        });
        if (!pullRequest)
            throw new NotFoundException('Pull request not found.');
        const language = await this.parameters.findByKey(
            ParametersKey.LANGUAGE_CONFIG,
            input.organizationAndTeamData,
        );
        const result = await this.risk.assess({
            organizationAndTeamData: input.organizationAndTeamData,
            repository,
            pullRequest: { ...pullRequest, number: input.prNumber },
            origin: 'preview',
            codeReviewConfig: {
                riskAssessmentActive: true,
                riskCriteria: criteria.data,
                languageResultPrompt:
                    typeof language?.configValue === 'string'
                        ? language.configValue
                        : 'en-US',
            },
        });
        return {
            assessment: result.assessment,
            files:
                result.fullPrFiles?.map((file) => ({
                    path: file.filename,
                    previousPath: file.previous_filename,
                    status: file.status,
                })) ?? [],
        };
    }
}
