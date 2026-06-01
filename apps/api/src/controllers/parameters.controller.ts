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
import { REQUEST } from '@nestjs/core';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiBody,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import {
    ApiStringResponseDto,
    ApiYamlStringResponseDto,
} from '../dtos/api-response.dto';
import {
    CodeReviewAutomationLabelsResponseDto,
    CodeReviewConfigResponseDto,
    CodeReviewParameterResponseDto,
    CodeReviewPresetResponseDto,
    ParametersStoredResponseDto,
} from '../dtos/parameters-response.dto';

import { ApplyCodeReviewPresetUseCase } from '@libs/code-review/application/use-cases/configuration/apply-code-review-preset.use-case';
import { CentralizedConfigSyncUseCase } from '@libs/centralized-config/application/use-cases/centralized-config-sync.use-case';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import { CodeReviewVersion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { toRequestUserContext } from '@libs/identity/domain/user/types/request-user-context.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';

import { DeleteRepositoryCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/delete-repository-code-review-parameter.use-case';
import { CentralizedConfigDownloadUseCase } from '@libs/centralized-config/application/use-cases/centralized-config-download.use-case';
import { CentralizedConfigInitUseCase } from '@libs/centralized-config/application/use-cases/centralized-config-init.use-case';
import { GenerateKodusConfigFileUseCase } from '@libs/code-review/application/use-cases/configuration/generate-kodus-config-file.use-case';
import { GetCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/get-code-review-parameter.use-case';
import { ListCodeReviewAutomationLabelsWithStatusUseCase } from '@libs/code-review/application/use-cases/configuration/list-code-review-automation-labels-with-status.use-case';
import { UpdateCodeReviewParameterRepositoriesUseCase } from '@libs/code-review/application/use-cases/configuration/update-code-review-parameter-repositories-use-case';
import { UpdateOrCreateCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/update-or-create-code-review-parameter-use-case';
import { PreviewPrSummaryUseCase } from '@libs/code-review/application/use-cases/summary/preview-pr-summary.use-case';
import { ParametersKey } from '@libs/core/domain/enums';
import {
    checkPermissions,
    checkRepoPermissions,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { FindByKeyParametersUseCase } from '@libs/organization/application/use-cases/parameters/find-by-key-use-case';
import { GetDefaultConfigUseCase } from '@libs/organization/application/use-cases/parameters/get-default-config.use-case';
import { CreateOrUpdateCodeReviewParameterDto } from '@libs/organization/dtos/create-or-update-code-review-parameter.dto';
import { DeleteRepositoryCodeReviewParameterDto } from '@libs/organization/dtos/delete-repository-code-review-parameter.dto';
import { PreviewPrSummaryDto } from '@libs/organization/dtos/preview-pr-summary.dto';
import { finished } from 'stream/promises';
import { ApplyCodeReviewPresetDto } from '../dtos/apply-code-review-preset.dto';

@ApiTags('Parameters')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
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
        private readonly centralizedConfigSyncUseCase: CentralizedConfigSyncUseCase,
        private readonly centralizedConfigDownloadUseCase: CentralizedConfigDownloadUseCase,
        private readonly centralizedConfigInitUseCase: CentralizedConfigInitUseCase,

        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,
    ) {}

    //#region Parameters
    @Post('/create-or-update')
    @ApiOperation({
        summary: 'Create or update parameter',
        description: 'Create or update a parameter configuration by key.',
    })
    @ApiCreatedResponse({ type: ParametersStoredResponseDto })
    @ApiBody({
        schema: {
            type: 'object',
            required: ['key', 'configValue', 'organizationAndTeamData'],
            properties: {
                key: {
                    type: 'string',
                    enum: Object.values(ParametersKey),
                },
                configValue: {
                    type: 'object',
                },
                organizationAndTeamData: {
                    type: 'object',
                    required: ['teamId'],
                    properties: {
                        teamId: { type: 'string' },
                    },
                },
            },
            example: {
                key: ParametersKey.CODE_REVIEW_CONFIG,
                configValue: {
                    useLLM: true,
                    reviewMode: 'comment',
                },
                organizationAndTeamData: {
                    teamId: 'c33ef663-70e7-4f43-9605-0bbef979b8e0',
                },
            },
        },
    })
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

        if (body.key === ParametersKey.CODE_REVIEW_CONFIG) {
            return await this.updateOrCreateCodeReviewParameterUseCase.execute({
                actor: {
                    source: 'web',
                    organizationId,
                },
                configValue: body.configValue,
                organizationAndTeamData: {
                    organizationId,
                    teamId: body.organizationAndTeamData.teamId,
                },
                requestUser: toRequestUserContext(this.request?.user),
            } as any);
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
    @ApiQuery({
        name: 'key',
        enum: ParametersKey,
        type: String,
        required: true,
    })
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @ApiOperation({
        summary: 'Find parameter by key',
        description: 'Return a parameter configuration by key for a team.',
    })
    @ApiOkResponse({ type: ParametersStoredResponseDto })
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
        const organizationId = this.request?.user?.organization?.uuid;

        return await this.findByKeyParametersUseCase.execute(key, {
            teamId,
            organizationId,
        });
    }

    //endregion
    //#region Code review routes

    @Get('/list-code-review-automation-labels')
    @ApiQuery({
        name: 'codeReviewVersion',
        enum: CodeReviewVersion,
        type: String,
        required: false,
    })
    @ApiQuery({ name: 'teamId', type: String, required: false })
    @ApiQuery({ name: 'repositoryId', type: String, required: false })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'List automation labels',
        description: 'Return automation labels for code review.',
    })
    @ApiOkResponse({ type: CodeReviewAutomationLabelsResponseDto })
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
    @ApiOperation({
        summary: 'Create or update code review config',
        description: 'Create or update code review parameters for a team.',
    })
    @ApiCreatedResponse({ type: ParametersStoredResponseDto })
    @ApiBadRequestResponse({
        description:
            'Validation error (e.g., configValue contains unsupported fields).',
    })
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
            requestUser: toRequestUserContext(this.request?.user),
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
    @ApiOperation({
        summary: 'Apply code review preset',
        description: 'Apply a preset configuration for a team.',
    })
    @ApiCreatedResponse({ type: CodeReviewPresetResponseDto })
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
    @ApiOperation({
        summary: 'Update code review repositories',
        description: 'Recalculate repositories for code review configuration.',
    })
    @ApiCreatedResponse({ type: ParametersStoredResponseDto })
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
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Get code review parameter',
        description: 'Return code review configuration for the team.',
    })
    @ApiOkResponse({ type: CodeReviewParameterResponseDto })
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
    @ApiOperation({
        summary: 'Get default code review config',
        description: 'Return the default code review configuration.',
    })
    @ApiOkResponse({ type: CodeReviewConfigResponseDto })
    public async getDefaultConfig() {
        return await this.getDefaultConfigUseCase.execute();
    }

    @Get('/generate-kodus-config-file')
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @ApiQuery({ name: 'repositoryId', type: String, required: false })
    @ApiQuery({ name: 'directoryId', type: String, required: false })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Generate Kodus config file',
        description: 'Return a YAML config file for the repository/team.',
    })
    @ApiOkResponse({
        type: ApiYamlStringResponseDto,
        content: { 'application/x-yaml': {} },
    })
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
    @ApiOperation({
        summary: 'Delete repository code review parameter',
        description:
            'Remove repository-level overrides from code review config.',
    })
    @ApiCreatedResponse({ type: ParametersStoredResponseDto })
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
    @ApiOperation({
        summary: 'Preview PR summary',
        description: 'Generate a preview summary for a pull request.',
    })
    @ApiCreatedResponse({ type: ApiStringResponseDto })
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

    @Get('/e2b-ip')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Get E2B IP address',
        description:
            'Return the E2B sandbox IP address for Git IP whitelisting.',
    })
    @ApiOkResponse({ description: 'E2B IP address' })
    public async getE2BIpAddress() {
        const ip = await this.codeBaseConfigService.getE2BIpAddress();
        return { ip };
    }
    //#endregion

    //#region Centralized config
    @Post('/centralized-config-sync')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Run centralized config sync',
        description: 'Runs an on-demand centralized config sync for a team.',
    })
    @ApiCreatedResponse({
        schema: {
            type: 'object',
            properties: {
                success: { type: 'boolean', example: true },
                message: {
                    type: 'string',
                    example: 'Centralized config synced successfully',
                },
            },
        },
    })
    public async syncCentralizedConfig(
        @Body()
        body: {
            teamId: string;
        },
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        const result = await this.centralizedConfigSyncUseCase.execute({
            organizationAndTeamData: {
                organizationId,
                teamId: body.teamId,
            },
        });

        return result;
    }

    @Get('/centralized-config-download')
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Download centralized config ZIP',
        description:
            "Download a ZIP containing the team's centralized kodus-config.yml files (global, per-repo and per-directory) ready to be placed in the central config repository.",
    })
    @ApiOkResponse({ content: { 'application/zip': {} } })
    public async downloadCentralizedConfig(
        @Res() response: Response,
        @Query('teamId') teamId: string,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        const entries = await this.centralizedConfigDownloadUseCase.execute(
            this.request.user,
            teamId,
        );

        response.set({
            'Content-Type': 'application/zip',
            'Content-Disposition':
                'attachment; filename=centralized-config.zip',
        });

        const { default: archiver } = await import('archiver');
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', (err) => {
            response.destroy(err);
        });
        archive.pipe(response);

        for (const entry of entries) {
            archive.append(entry.content, { name: entry.path });
        }

        await archive.finalize();
        if (typeof (response as any).on === 'function') {
            await finished(response as any);
        }
        return;
    }

    @Post('/centralized-config-init')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Initialize centralized config',
        description:
            'Initialize centralized configuration for a team by creating a PR with their current config.',
    })
    @ApiCreatedResponse({
        schema: {
            type: 'object',
            properties: {
                success: { type: 'boolean', example: true },
                message: {
                    type: 'string',
                    example: 'Centralized config initialized successfully',
                },
                prUrl: {
                    type: 'string',
                    example: 'https://github.com/foo/bar/pull/123',
                    nullable: true,
                },
            },
        },
    })
    public async initializeCentralizedConfig(
        @Body()
        body: {
            teamId: string;
            repository: {
                id: string;
                name: string;
            };
            syncOption: 'pr' | 'manual';
        },
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        const result = await this.centralizedConfigInitUseCase.execute({
            user: this.request.user,
            organizationAndTeamData: {
                organizationId,
                teamId: body.teamId,
            },
            repository: body.repository,
            syncOption: body.syncOption,
        });

        return result;
    }
    //#endregion
}
