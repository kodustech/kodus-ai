import {
    Body,
    Controller,
    Get,
    Inject,
    Param,
    Post,
    Query,
    Res,
    UseGuards,
} from '@nestjs/common';
import { maskCliSecrets } from '@libs/code-review/domain/custom-agents/cli-secrets';
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
    ApiArrayResponseDto,
    ApiStringResponseDto,
    ApiYamlStringResponseDto,
} from '../dtos/api-response.dto';
import {
    CodeReviewAutomationLabelsResponseDto,
    CodeReviewConfigResponseDto,
    CodeReviewParameterResponseDto,
    ParametersStoredResponseDto,
} from '../dtos/parameters-response.dto';

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
import { CentralizedConfigDownloadZipUseCase } from '@libs/centralized-config/application/use-cases/centralized-config-download-zip.use-case';
import { CentralizedConfigInitUseCase } from '@libs/centralized-config/application/use-cases/centralized-config-init.use-case';
import { GenerateKodusConfigFileUseCase } from '@libs/code-review/application/use-cases/configuration/generate-kodus-config-file.use-case';
import { GetCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/get-code-review-parameter.use-case';
import { GetCodeReviewScopesUseCase } from '@libs/code-review/application/use-cases/configuration/get-code-review-scopes.use-case';
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
import { SetEnvironmentSecretsDto } from '@libs/organization/dtos/environment-secrets.dto';
import { SetEnvironmentInfraDto } from '@libs/organization/dtos/environment-infra.dto';
import { PreviewEnvSecretsService } from '@libs/code-review/pipeline/services/preview-env-secrets.service';
import { PreviewEnvInfraService } from '@libs/code-review/pipeline/services/preview-env-infra.service';
import { RuntimeRunRepository } from '@libs/code-review/infrastructure/adapters/repositories/runtimeRun.repository';
import { RuntimePlaybookDraftRepository } from '@libs/code-review/infrastructure/adapters/repositories/runtimePlaybookDraft.repository';
import { PreviewEnvGenerateService } from '@libs/code-review/pipeline/services/preview-env-generate.service';
import { GenerateRuntimePlaybookDto } from '@libs/organization/dtos/generate-runtime-playbook.dto';
import { randomUUID } from 'crypto';
import { transcriptToAsciicast } from '@libs/code-review/pipeline/services/preview-env-run';
import { DeleteRepositoryCodeReviewParameterDto } from '@libs/organization/dtos/delete-repository-code-review-parameter.dto';
import { PreviewPrSummaryDto } from '@libs/organization/dtos/preview-pr-summary.dto';
import { finished } from 'stream/promises';
import { TenantScopeGuard } from '../guards/tenant-scope.guard';

@ApiTags('Parameters')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@UseGuards(TenantScopeGuard)
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
        private readonly getCodeReviewScopesUseCase: GetCodeReviewScopesUseCase,
        private readonly centralizedConfigSyncUseCase: CentralizedConfigSyncUseCase,
        private readonly centralizedConfigDownloadZipUseCase: CentralizedConfigDownloadZipUseCase,
        private readonly centralizedConfigInitUseCase: CentralizedConfigInitUseCase,

        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,

        // Preview-env alpha: encrypted per-repo secrets vault + org infra.
        private readonly previewEnvSecretsService: PreviewEnvSecretsService,
        private readonly previewEnvInfraService: PreviewEnvInfraService,
        // Kody Runtime run records for the PR-side viewer.
        private readonly runtimeRunRepository: RuntimeRunRepository,
        // "Generate config" — detect-agent orchestration + async draft store.
        private readonly previewEnvGenerateService: PreviewEnvGenerateService,
        private readonly runtimePlaybookDraftRepository: RuntimePlaybookDraftRepository,
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
            return maskCliSecrets(
                await this.updateOrCreateCodeReviewParameterUseCase.execute({
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
                } as any),
            );
        }

        return maskCliSecrets(
            await this.createOrUpdateParametersUseCase.execute(
                body.key,
                body.configValue,
                {
                    organizationId,
                    teamId: body.organizationAndTeamData.teamId,
                },
            ),
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

        return maskCliSecrets(
            await this.findByKeyParametersUseCase.execute(key, {
                teamId,
                organizationId,
            }),
        );
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

        return maskCliSecrets(
            await this.updateOrCreateCodeReviewParameterUseCase.execute({
                ...body,
                organizationAndTeamData: {
                    ...body.organizationAndTeamData,
                    organizationId,
                },
                requestUser: toRequestUserContext(this.request?.user),
            }),
        );
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

        return maskCliSecrets(
            await this.updateCodeReviewParameterRepositoriesUseCase.execute({
                ...body,
                organizationAndTeamData: {
                    ...body.organizationAndTeamData,
                    organizationId,
                },
            }),
        );
    }

    @Get('/code-review-parameter')
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @ApiQuery({
        name: 'includeFileOverlay',
        type: Boolean,
        required: false,
        description:
            "Overlay each repository's kodus-config.yml, read live from the git provider. Defaults to true; pass false for a fast response backed only by stored configuration.",
    })
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
    public async getCodeReviewParameter(
        @Query('teamId') teamId: string,
        @Query('includeFileOverlay') includeFileOverlay?: string,
    ) {
        return maskCliSecrets(
            await this.getCodeReviewParameterUseCase.execute(
                this.request.user,
                teamId,
                { includeFileOverlay: includeFileOverlay !== 'false' },
            ),
        );
    }

    @Get('/code-review-scopes')
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'List code review scopes',
        description:
            'Repositories and configured directories as ids and names only, for scope pickers. Unlike /code-review-parameter it returns no configuration and never reads kodus-config.yml from the git provider.',
    })
    @ApiOkResponse({ type: ApiArrayResponseDto })
    public async getCodeReviewScopes(@Query('teamId') teamId: string) {
        return this.getCodeReviewScopesUseCase.execute(
            this.request.user,
            teamId,
        );
    }

    //#region Preview-env secrets vault (alpha)
    // The encrypted per-repo `.env` for the preview-environment feature. Values
    // are stored encrypted and NEVER returned — only the set of NAMES via the
    // status endpoint. The playbook config itself rides the normal code-review
    // config save (the `environment` field), so it needs no endpoint here.
    @Post('/environment-secrets')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkRepoPermissions({
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
            repo: { key: { body: 'repositoryId' } },
        }),
    )
    @ApiOperation({
        summary: 'Set preview-env secrets',
        description:
            'Create/update the encrypted per-repo secrets for the preview environment. An empty value removes a key; omitted keys are kept. Values are never returned.',
    })
    @ApiCreatedResponse({ type: ApiStringResponseDto })
    public async setEnvironmentSecrets(
        @Body() body: SetEnvironmentSecretsDto,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        await this.previewEnvSecretsService.setSecrets(
            { ...body.organizationAndTeamData, organizationId },
            body.repositoryId,
            body.secrets ?? {},
        );

        const names = await this.previewEnvSecretsService.getStatus(
            { ...body.organizationAndTeamData, organizationId },
            body.repositoryId,
        );
        return { configured: names };
    }

    @Get('/environment-secrets/status')
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @ApiQuery({ name: 'repositoryId', type: String, required: true })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkRepoPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
            repo: { key: { query: 'repositoryId' } },
        }),
    )
    @ApiOperation({
        summary: 'Get preview-env secrets status',
        description:
            'Return the NAMES of the secrets configured for a repo (never the values).',
    })
    @ApiOkResponse({ type: ApiStringResponseDto })
    public async getEnvironmentSecretsStatus(
        @Query('teamId') teamId: string,
        @Query('repositoryId') repositoryId: string,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        const names = await this.previewEnvSecretsService.getStatus(
            { teamId, organizationId },
            repositoryId,
        );
        return { configured: names };
    }

    // "Generate config" — the detect agent drafts the playbook from the real
    // repo so the user never hand-writes it. A VM boot + agent run is minutes,
    // too long to block on, so this kicks it off and returns a draftId to poll.
    @Post('/runtime/generate')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkRepoPermissions({
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
            repo: { key: { body: 'repositoryId' } },
        }),
    )
    @ApiOperation({
        summary: 'Generate a Kody Runtime playbook',
        description:
            'Spin up an ephemeral VM, run the detect agent to draft a .kody/runtime.yml, and store it under a draftId to poll.',
    })
    public async generateRuntimePlaybook(
        @Body() body: GenerateRuntimePlaybookDto,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }
        const org = { ...body.organizationAndTeamData, organizationId };
        const draftId = randomUUID();
        await this.runtimePlaybookDraftRepository.create({
            draftId,
            organizationId,
            teamId: body.organizationAndTeamData.teamId,
            repositoryId: body.repositoryId,
        });
        // Out-of-band: the detect run takes minutes; the UI polls the draft.
        void this.previewEnvGenerateService
            .generate({
                organizationAndTeamData: org,
                repositoryId: body.repositoryId,
                branch: body.branch,
            })
            .then((result) =>
                this.runtimePlaybookDraftRepository.complete(
                    draftId,
                    result.success ? 'done' : 'error',
                    result,
                ),
            )
            .catch((error) =>
                this.runtimePlaybookDraftRepository.complete(draftId, 'error', {
                    success: false,
                    error: String(error?.message ?? error),
                }),
            );
        return { draftId, status: 'running' };
    }

    @Get('/runtime/generate/:draftId')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Poll a Generate-config job',
        description:
            'Returns { status: running | done | error, result } for a draftId.',
    })
    public async getRuntimePlaybookDraft(@Param('draftId') draftId: string) {
        const draft =
            await this.runtimePlaybookDraftRepository.findByDraftId(draftId);
        if (!draft) return { status: 'not_found', result: null };
        return { status: draft.status, result: draft.result ?? null };
    }

    // Org-level infrastructure config (advanced / self-hosted BYO-cloud):
    // WHERE the preview VM is provisioned. The cloud token is encrypted at
    // rest and never returned; absent config → server-level env fallback.
    @Post('/environment-infra')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Set preview-env infrastructure',
        description:
            'Configure the cloud where preview-env VMs run (org-level). Token: empty removes, omitted keeps. Never returned.',
    })
    @ApiCreatedResponse({ type: ApiStringResponseDto })
    public async setEnvironmentInfra(@Body() body: SetEnvironmentInfraDto) {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        const orgAndTeam = { ...body.organizationAndTeamData, organizationId };
        await this.previewEnvInfraService.setInfra(orgAndTeam, {
            provider: body.provider,
            token: body.token,
            region: body.region,
            serverType: body.serverType,
        });
        return this.previewEnvInfraService.getStatus(orgAndTeam);
    }

    @Get('/environment-infra/status')
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Get preview-env infrastructure status',
        description:
            'Provider/region/serverType + whether a token is configured (never the token).',
    })
    @ApiOkResponse({ type: ApiStringResponseDto })
    public async getEnvironmentInfraStatus(@Query('teamId') teamId: string) {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        return this.previewEnvInfraService.getStatus({
            teamId,
            organizationId,
        });
    }

    // Kody Runtime run viewer — the full redacted record (transcript + logs) so
    // the reviewer can see 100% of what happened in the VM.
    @Get('/runtime-run/:runId')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Get a Kody Runtime run',
        description: 'The full redacted run record (transcript, phase/service logs, summary, findings).',
    })
    @ApiOkResponse({ type: ApiStringResponseDto })
    public async getRuntimeRun(@Param('runId') runId: string) {
        const run = await this.runtimeRunRepository.findByRunId(runId);
        return run?.record ?? null;
    }

    @Get('/runtime-run/:runId/cast')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Download the run as an asciinema recording',
        description: 'The agent session as a .cast terminal recording (plays in any asciinema player).',
    })
    public async getRuntimeRunCast(
        @Param('runId') runId: string,
        @Res() response: Response,
    ) {
        const run = await this.runtimeRunRepository.findByRunId(runId);
        if (!run?.record) {
            response.status(404).send('not found');
            return;
        }
        response.set({
            'Content-Type': 'application/x-asciicast',
            'Content-Disposition': `attachment; filename="kody-runtime-${runId}.cast"`,
        });
        response.send(transcriptToAsciicast(run.record));
    }

    @Get('/runtime-runs')
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @ApiQuery({ name: 'repositoryId', type: String, required: true })
    @ApiQuery({ name: 'prNumber', type: Number, required: true })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'List Kody Runtime runs for a PR',
        description: 'Lightweight history (status, findings count, timings) — no transcript.',
    })
    @ApiOkResponse({ type: ApiStringResponseDto })
    public async listRuntimeRuns(
        @Query('repositoryId') repositoryId: string,
        @Query('prNumber') prNumber: string,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }
        return this.runtimeRunRepository.listByPr(
            organizationId,
            repositoryId,
            Number(prNumber),
        );
    }
    //#endregion

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
        return maskCliSecrets(
            await this.deleteRepositoryCodeReviewParameterUseCase.execute(body),
        );
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

        const archive = await this.centralizedConfigDownloadZipUseCase.execute(
            this.request.user,
            teamId,
        );

        response.set({
            'Content-Type': 'application/zip',
            'Content-Disposition':
                'attachment; filename=centralized-config.zip',
        });

        archive.on('error', (err) => {
            response.destroy(err);
        });
        archive.pipe(response);

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
