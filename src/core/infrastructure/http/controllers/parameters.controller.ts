import { CreateOrUpdateParametersUseCase } from '@/core/application/use-cases/parameters/create-or-update-use-case';
import { FindByKeyParametersUseCase } from '@/core/application/use-cases/parameters/find-by-key-use-case';
import { UpdateCodeReviewParameterRepositoriesUseCase } from '@/core/application/use-cases/parameters/update-code-review-parameter-repositories-use-case';
import { UpdateOrCreateCodeReviewParameterUseCase } from '@/core/application/use-cases/parameters/update-or-create-code-review-parameter-use-case';

import { ListCodeReviewAutomationLabelsWithStatusUseCase } from '@/core/application/use-cases/parameters/list-code-review-automation-labels-with-status.use-case';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import {
    Body,
    Controller,
    Get,
    Inject,
    Post,
    Query,
    Res,
    UseGuards,
} from '@nestjs/common';
import { Response } from 'express';

import { CodeReviewVersion } from '@/config/types/general/codeReview.type';
import { UserRequest } from '@/config/types/http/user-request.type';
import { DeleteRepositoryCodeReviewParameterUseCase } from '@/core/application/use-cases/parameters/delete-repository-code-review-parameter.use-case';
import { GenerateKodusConfigFileUseCase } from '@/core/application/use-cases/parameters/generate-kodus-config-file.use-case';
import { GetCodeReviewParameterUseCase } from '@/core/application/use-cases/parameters/get-code-review-parameter.use-case';
import { GetDefaultConfigUseCase } from '@/core/application/use-cases/parameters/get-default-config.use-case';
import { PreviewPrSummaryUseCase } from '@/core/application/use-cases/parameters/preview-pr-summary.use-case';
import { ApplyCodeReviewPresetUseCase } from '@/core/application/use-cases/parameters/apply-code-review-preset.use-case';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import { REQUEST } from '@nestjs/core';
import {
    CheckPolicies,
    PolicyGuard,
} from '../../adapters/services/permissions/policy.guard';
import {
    checkPermissions,
    checkRepoPermissions,
} from '../../adapters/services/permissions/policy.handlers';
import { ApplyCodeReviewPresetDto } from '../dtos/apply-code-review-preset.dto';
import { CreateOrUpdateCodeReviewParameterDto } from '../dtos/create-or-update-code-review-parameter.dto';
import { DeleteRepositoryCodeReviewParameterDto } from '../dtos/delete-repository-code-review-parameter.dto';
import { PreviewPrSummaryDto } from '../dtos/preview-pr-summary.dto';

@Controller('parameters')
export class ParametersController {
    constructor(
        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly findByKeyParametersUseCase: FindByKeyParametersUseCase,
        private readonly updateOrCreateCodeReviewParameterUseCase: UpdateOrCreateCodeReviewParameterUseCase,
        private readonly updateCodeReviewParameterRepositoriesUseCase: UpdateCodeReviewParameterRepositoriesUseCase,
        private readonly generateKodusConfigFileUseCase: GenerateKodusConfigFileUseCase,
        private readonly deleteRepositoryCodeReviewParameterUseCase: DeleteRepositoryCodeReviewParameterUseCase,
        private readonly previewPrSummaryUseCase: PreviewPrSummaryUseCase,
        private readonly listCodeReviewAutomationLabelsWithStatusUseCase: ListCodeReviewAutomationLabelsWithStatusUseCase,
        private readonly getDefaultConfigUseCase: GetDefaultConfigUseCase,
        private readonly getCodeReviewParameterUseCase: GetCodeReviewParameterUseCase,
        private readonly applyCodeReviewPresetUseCase: ApplyCodeReviewPresetUseCase,
    ) {}

    //#region Parameters
    @Post('/create-or-update')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async createOrUpdate(
        @Body()
        body: {
            key: ParametersKey;
            configValue: any;
            organizationAndTeamData: { teamId: string };
        },
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        return await this.createOrUpdateParametersUseCase.execute(
            body.key,
            body.configValue,
            {
                organizationId,
                teamId: body.organizationAndTeamData.teamId,
            },
        );
    }

    @Get('/find-by-key')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async findByKey(
        @Query('key') key: ParametersKey,
        @Query('teamId') teamId: string,
    ) {
        return await this.findByKeyParametersUseCase.execute(key, { teamId });
    }

    //endregion
    //#region Code review routes

    @Get('/list-code-review-automation-labels')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async listCodeReviewAutomationLabels(
        @Query('codeReviewVersion') codeReviewVersion?: CodeReviewVersion,
        @Query('teamId') teamId?: string,
        @Query('repositoryId') repositoryId?: string,
    ) {
        return this.listCodeReviewAutomationLabelsWithStatusUseCase.execute({
            codeReviewVersion,
            teamId,
            repositoryId,
        });
    }

    @Post('/create-or-update-code-review')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async updateOrCreateCodeReviewParameter(
        @Body()
        body: CreateOrUpdateCodeReviewParameterDto,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        return await this.updateOrCreateCodeReviewParameterUseCase.execute({
            ...body,
            organizationAndTeamData: {
                ...body.organizationAndTeamData,
                organizationId,
            },
        });
    }

    @Post('/apply-code-review-preset')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async applyCodeReviewPreset(
        @Body()
        body: ApplyCodeReviewPresetDto,
    ) {
        return await this.applyCodeReviewPresetUseCase.execute(body);
    }

    @Post('/update-code-review-parameter-repositories')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async UpdateCodeReviewParameterRepositories(
        @Body()
        body: {
            organizationAndTeamData: { teamId: string };
        },
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        return await this.updateCodeReviewParameterRepositoriesUseCase.execute({
            ...body,
            organizationAndTeamData: {
                ...body.organizationAndTeamData,
                organizationId,
            },
        });
    }

    @Get('/code-review-parameter')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async getCodeReviewParameter(@Query('teamId') teamId: string) {
        return await this.getCodeReviewParameterUseCase.execute(
            this.request.user,
            teamId,
        );
    }

    @Get('/default-code-review-parameter')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async getDefaultConfig() {
        return await this.getDefaultConfigUseCase.execute();
    }

    @Get('/generate-kodus-config-file')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async GenerateKodusConfigFile(
        @Res() response: Response,
        @Query('teamId') teamId: string,
        @Query('repositoryId') repositoryId?: string,
        @Query('directoryId') directoryId?: string,
    ) {
        const { yamlString } =
            await this.generateKodusConfigFileUseCase.execute(
                teamId,
                repositoryId,
                directoryId,
            );

        response.set({
            'Content-Type': 'application/x-yaml',
            'Content-Disposition': 'attachment; filename=kodus-config.yml',
        });

        return response.send(yamlString);
    }

    @Post('/delete-repository-code-review-parameter')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkRepoPermissions({
            action: Action.Delete,
            resource: ResourceType.CodeReviewSettings,
            repo: {
                key: {
                    body: 'repositoryId',
                },
            },
        }),
    )
    public async deleteRepositoryCodeReviewParameter(
        @Body()
        body: DeleteRepositoryCodeReviewParameterDto,
    ) {
        return this.deleteRepositoryCodeReviewParameterUseCase.execute(body);
    }
    //#endregion

    @Post('/preview-pr-summary')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async previewPrSummary(
        @Body()
        body: PreviewPrSummaryDto,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        return this.previewPrSummaryUseCase.execute({
            ...body,
            organizationId,
        });
    }
}
