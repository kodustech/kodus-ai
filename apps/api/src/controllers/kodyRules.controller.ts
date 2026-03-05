import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { AddLibraryKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/add-library-kody-rules.use-case';
import { ApplyPendingKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/apply-pending-kody-rules.use-case';
import { ChangeStatusKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/change-status-kody-rules.use-case';
import { CheckSyncStatusUseCase } from '@libs/kodyRules/application/use-cases/check-sync-status.use-case';
import { ConvertPendingUpdatesToMemoriesUseCase } from '@libs/kodyRules/application/use-cases/convert-pending-updates-to-memories.use-case';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/delete-rule-in-organization-by-id.use-case';
import { FastSyncIdeRulesUseCase } from '@libs/kodyRules/application/use-cases/fast-sync-ide-rules.use-case';
import { FindByOrganizationIdKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/find-by-organization-id.use-case';
import { FindLibraryKodyRulesBucketsUseCase } from '@libs/kodyRules/application/use-cases/find-library-kody-rules-buckets.use-case';
import { FindLibraryKodyRulesWithFeedbackUseCase } from '@libs/kodyRules/application/use-cases/find-library-kody-rules-with-feedback.use-case';
import { FindLibraryKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/find-library-kody-rules.use-case';
import { FindRecommendedKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/find-recommended-kody-rules.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/find-rules-in-organization-by-filter.use-case';
import { FindSuggestionsByRuleUseCase } from '@libs/kodyRules/application/use-cases/find-suggestions-by-rule.use-case';
import { GenerateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/generate-kody-rules.use-case';
import { GetInheritedRulesKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/get-inherited-kody-rules.use-case';
import { GetRulesLimitStatusUseCase } from '@libs/kodyRules/application/use-cases/get-rules-limit-status.use-case';
import { ImportFastKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/import-fast-kody-rules.use-case';
import { ResyncRulesFromIdeUseCase } from '@libs/kodyRules/application/use-cases/resync-rules-from-ide.use-case';
import { SyncSelectedRepositoriesKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/sync-selected-repositories.use-case';
import { ImportFastKodyRulesDto } from '@libs/kodyRules/dtos/import-fast-kody-rules.dto';
import { ReviewFastKodyRulesDto } from '../dtos/review-fast-kody-rules.dto';

import { CacheService } from '@libs/core/cache/cache.service';
import { CreateKodyRuleDto } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import {
    checkPermissions,
    checkRepoPermissions,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { AddLibraryKodyRulesDto } from '@libs/kodyRules/dtos/add-library-kody-rules.dto';
import { ChangeStatusKodyRulesDTO } from '@libs/kodyRules/dtos/change-status-kody-rules.dto';
import { RuleIdsDto } from '@libs/kodyRules/dtos/rule-ids.dto';
import {
    Body,
    Controller,
    Delete,
    Get,
    Inject,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiNoContentResponse,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import {
    ApiArrayResponseDto,
    ApiBooleanResponseDto,
    ApiObjectResponseDto,
} from '../dtos/api-response.dto';
import { FindLibraryKodyRulesDto } from '../dtos/find-library-kody-rules.dto';
import { FindRecommendedKodyRulesDto } from '../dtos/find-recommended-kody-rules.dto';
import { FindSuggestionsByRuleDto } from '../dtos/find-suggestions-by-rule.dto';
import { GenerateKodyRulesDTO } from '../dtos/generate-kody-rules.dto';
import {
    KodyRuleResponseDto,
    KodyRulesArrayResponseDto,
    KodyRulesBucketsResponseDto,
    KodyRulesFastSyncResponseDto,
    KodyRulesFindByOrgResponseDto,
    KodyRulesInheritedResponseDto,
    KodyRulesLibraryResponseDto,
    KodyRulesLimitResponseDto,
    KodyRulesSyncStatusResponseDto,
} from '../dtos/kody-rules-response.dto';

@ApiTags('Kody Rules')
@ApiStandardResponses()
@Controller('kody-rules')
export class KodyRulesController {
    constructor(
        private readonly createOrUpdateKodyRulesUseCase: CreateOrUpdateKodyRulesUseCase,
        private readonly findByOrganizationIdKodyRulesUseCase: FindByOrganizationIdKodyRulesUseCase,
        private readonly findRulesInOrganizationByRuleFilterKodyRulesUseCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
        private readonly deleteRuleInOrganizationByIdKodyRulesUseCase: DeleteRuleInOrganizationByIdKodyRulesUseCase,
        private readonly findLibraryKodyRulesUseCase: FindLibraryKodyRulesUseCase,
        private readonly findLibraryKodyRulesWithFeedbackUseCase: FindLibraryKodyRulesWithFeedbackUseCase,
        private readonly findLibraryKodyRulesBucketsUseCase: FindLibraryKodyRulesBucketsUseCase,
        private readonly findRecommendedKodyRulesUseCase: FindRecommendedKodyRulesUseCase,
        private readonly addLibraryKodyRulesUseCase: AddLibraryKodyRulesUseCase,
        private readonly generateKodyRulesUseCase: GenerateKodyRulesUseCase,
        private readonly applyPendingKodyRulesUseCase: ApplyPendingKodyRulesUseCase,
        private readonly changeStatusKodyRulesUseCase: ChangeStatusKodyRulesUseCase,
        private readonly checkSyncStatusUseCase: CheckSyncStatusUseCase,
        private readonly cacheService: CacheService,
        private readonly syncSelectedReposKodyRulesUseCase: SyncSelectedRepositoriesKodyRulesUseCase,
        private readonly getInheritedRulesKodyRulesUseCase: GetInheritedRulesKodyRulesUseCase,
        private readonly getRulesLimitStatusUseCase: GetRulesLimitStatusUseCase,
        private readonly findSuggestionsByRuleUseCase: FindSuggestionsByRuleUseCase,
        private readonly resyncRulesFromIdeUseCase: ResyncRulesFromIdeUseCase,
        private readonly fastSyncIdeRulesUseCase: FastSyncIdeRulesUseCase,
        private readonly importFastKodyRulesUseCase: ImportFastKodyRulesUseCase,
        private readonly convertPendingUpdatesToMemoriesUseCase: ConvertPendingUpdatesToMemoriesUseCase,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @ApiBearerAuth('jwt')
    @Post('/create-or-update')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Create or update rule',
        description: 'Create a new rule or update an existing one.',
    })
    @ApiCreatedResponse({ type: KodyRuleResponseDto })
    public async create(
        @Body()
        body: CreateKodyRuleDto,
    ) {
        if (!this.request.user.organization.uuid) {
            throw new Error('Organization ID not found');
        }
        return this.createOrUpdateKodyRulesUseCase.execute(
            body,
            this.request.user.organization.uuid,
        );
    }

    @ApiBearerAuth('jwt')
    @Get('/find-by-organization-id')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'List rules by organization',
        description: 'Return all rules for the current organization.',
    })
    @ApiOkResponse({ type: KodyRulesFindByOrgResponseDto })
    public async findByOrganizationId() {
        return this.findByOrganizationIdKodyRulesUseCase.execute();
    }

    @ApiBearerAuth('jwt')
    @Get('/limits')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Get rules limit status',
        description: 'Return the current kody rules limit usage.',
    })
    @ApiOkResponse({ type: KodyRulesLimitResponseDto })
    public async getRulesLimitStatus() {
        return this.getRulesLimitStatusUseCase.execute();
    }

    @ApiBearerAuth('jwt')
    @Get('/suggestions')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Get suggestions by rule',
        description: 'Return suggestions for a specific rule.',
    })
    @ApiOkResponse({ type: ApiArrayResponseDto })
    public async findSuggestionsByRule(
        @Query() query: FindSuggestionsByRuleDto,
    ) {
        return this.findSuggestionsByRuleUseCase.execute(query.ruleId);
    }

    @ApiBearerAuth('jwt')
    @Get('/find-rules-in-organization-by-filter')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Find rules by filter',
        description: 'Return rules matching a key/value filter.',
    })
    @ApiQuery({ name: 'key', type: String, required: true })
    @ApiQuery({ name: 'value', type: String, required: true })
    @ApiQuery({ name: 'repositoryId', type: String, required: false })
    @ApiQuery({ name: 'directoryId', type: String, required: false })
    @ApiOkResponse({ type: ApiArrayResponseDto })
    public async findRulesInOrganizationByFilter(
        @Query('key')
        key: string,
        @Query('value')
        value: string,
        @Query('repositoryId')
        repositoryId?: string,
        @Query('directoryId')
        directoryId?: string,
    ) {
        if (!this.request.user.organization.uuid) {
            throw new Error('Organization ID not found');
        }

        return this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
            this.request.user.organization.uuid,
            { [key]: value },
            repositoryId,
            directoryId,
        );
    }

    @ApiBearerAuth('jwt')
    @Delete('/delete-rule-in-organization-by-id')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Delete,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Delete rule by id',
        description: 'Delete a rule in the organization by rule id.',
    })
    @ApiQuery({ name: 'ruleId', type: String, required: true })
    @ApiOkResponse({ type: ApiBooleanResponseDto })
    public async deleteRuleInOrganizationById(
        @Query('ruleId')
        ruleId: string,
    ) {
        return this.deleteRuleInOrganizationByIdKodyRulesUseCase.execute(
            ruleId,
        );
    }

    @Get('/find-library-kody-rules')
    @Public()
    @ApiOperation({
        summary: 'List library rules',
        description: 'Return library rules with pagination.',
    })
    @ApiOkResponse({ type: KodyRulesLibraryResponseDto })
    public async findLibraryKodyRules(@Query() query: FindLibraryKodyRulesDto) {
        return this.findLibraryKodyRulesUseCase.execute(query);
    }

    @ApiBearerAuth('jwt')
    @Get('/find-library-kody-rules-with-feedback')
    @ApiOperation({
        summary: 'List library rules with feedback',
        description: 'Return library rules with user feedback and pagination.',
    })
    @ApiOkResponse({ type: KodyRulesLibraryResponseDto })
    public async findLibraryKodyRulesWithFeedback(
        @Query() query: FindLibraryKodyRulesDto,
    ) {
        return this.findLibraryKodyRulesWithFeedbackUseCase.execute(query);
    }

    @Get('/find-library-kody-rules-buckets')
    @Public()
    @ApiOperation({
        summary: 'List library buckets',
        description: 'Return available kody rules buckets.',
    })
    @ApiOkResponse({ type: KodyRulesBucketsResponseDto })
    public async findLibraryKodyRulesBuckets() {
        return this.findLibraryKodyRulesBucketsUseCase.execute();
    }

    @ApiBearerAuth('jwt')
    @Get('/find-recommended-kody-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Find recommended rules',
        description: 'Return recommended rules for the organization.',
    })
    @ApiQuery({ name: 'limit', type: Number, required: false })
    @ApiOkResponse({ type: ApiArrayResponseDto })
    public async findRecommendedKodyRules(
        @Query() query: FindRecommendedKodyRulesDto,
    ) {
        if (!this.request.user.organization.uuid) {
            throw new Error('Organization ID not found');
        }

        const limit = query.limit || 10;
        const cacheKey = `recommended-kody-rules:${this.request.user.organization.uuid}:${limit}`;

        const cachedResult = await this.cacheService.getFromCache(cacheKey);
        if (cachedResult) {
            return cachedResult;
        }

        const result = await this.findRecommendedKodyRulesUseCase.execute(
            {
                organizationId: this.request.user.organization.uuid,
                teamId: (this.request.user as any).team?.uuid,
            },
            limit,
        );

        await this.cacheService.addToCache(cacheKey, result, 259200000);

        return result;
    }

    @ApiBearerAuth('jwt')
    @Post('/add-library-kody-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Add library rules',
        description: 'Add library rules to the organization repositories.',
    })
    @ApiCreatedResponse({ type: KodyRulesArrayResponseDto })
    public async addLibraryKodyRules(@Body() body: AddLibraryKodyRulesDto) {
        return this.addLibraryKodyRulesUseCase.execute(body);
    }

    @ApiBearerAuth('jwt')
    @Post('/generate-kody-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Generate rules',
        description: 'Generate rules based on repository history.',
    })
    @ApiCreatedResponse({ type: KodyRulesArrayResponseDto })
    public async generateKodyRules(@Body() body: GenerateKodyRulesDTO) {
        if (!this.request.user.organization.uuid) {
            throw new Error('Organization ID not found');
        }

        return this.generateKodyRulesUseCase.execute(
            body,
            this.request.user.organization.uuid,
        );
    }

    @ApiBearerAuth('jwt')
    @Post('/change-status-kody-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Change rule status',
        description: 'Update status for one or more rules.',
    })
    @ApiCreatedResponse({ type: KodyRulesArrayResponseDto })
    public async changeStatusKodyRules(@Body() body: ChangeStatusKodyRulesDTO) {
        return this.changeStatusKodyRulesUseCase.execute(body);
    }

    @ApiBearerAuth('jwt')
    @Post('/pending/apply')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Apply pending rules',
        description: 'Approve one or more pending rules/memories.',
    })
    @ApiCreatedResponse({ type: KodyRulesArrayResponseDto })
    public async applyPendingKodyRules(@Body() body: RuleIdsDto) {
        return this.applyPendingKodyRulesUseCase.execute(body);
    }

    @ApiBearerAuth('jwt')
    @Post('/pending/discard')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Discard pending rules',
        description: 'Reject one or more pending rules/memories.',
    })
    @ApiCreatedResponse({ type: KodyRulesArrayResponseDto })
    public async discardPendingKodyRules(@Body() body: RuleIdsDto) {
        return this.changeStatusKodyRulesUseCase.execute({
            ruleIds: body.ruleIds,
            status: KodyRulesStatus.REJECTED,
        });
    }

    @ApiBearerAuth('jwt')
    @Post('/pending/convert-updates-to-memories')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Convert pending updates to new memories',
        description:
            'For each pending update request, create a new active memory and discard the original pending request.',
    })
    @ApiCreatedResponse({ type: KodyRulesArrayResponseDto })
    public async convertPendingUpdatesToNewMemories(@Body() body: RuleIdsDto) {
        return this.convertPendingUpdatesToMemoriesUseCase.execute(body);
    }

    @ApiBearerAuth('jwt')
    @Get('/check-sync-status')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Check sync status',
        description: 'Return sync status flags for IDE and generator.',
    })
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @ApiQuery({ name: 'repositoryId', type: String, required: false })
    @ApiOkResponse({ type: KodyRulesSyncStatusResponseDto })
    public async checkSyncStatus(
        @Query('teamId')
        teamId: string,
        @Query('repositoryId')
        repositoryId?: string,
    ) {
        const cacheKey = `check-sync-status:${this.request.user.organization.uuid}:${teamId}:${repositoryId || 'no-repo'}`;

        // Tenta buscar do cache primeiro
        const cachedResult = await this.cacheService.getFromCache(cacheKey);
        if (cachedResult) {
            return cachedResult;
        }

        // If not in cache, execute the use case
        const result = await this.checkSyncStatusUseCase.execute(
            teamId,
            repositoryId,
        );

        // Salva no cache por 15 minutos
        await this.cacheService.addToCache(cacheKey, result, 900000); // 15 minutos em milissegundos

        return result;
    }

    @ApiBearerAuth('jwt')
    @Post('/sync-ide-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Sync IDE rules',
        description: 'Sync IDE rules for a repository.',
    })
    @ApiNoContentResponse({ description: 'Sync started' })
    public async syncIdeRules(
        @Body() body: { teamId: string; repositoryId: string },
    ) {
        const respositories = [body.repositoryId];

        return this.syncSelectedReposKodyRulesUseCase.execute({
            teamId: body.teamId,
            repositoriesIds: respositories,
        });
    }

    @ApiBearerAuth('jwt')
    @Post('/fast-sync-ide-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Fast sync IDE rules',
        description: 'Fast sync IDE rules with optional limits.',
    })
    @ApiCreatedResponse({ type: KodyRulesFastSyncResponseDto })
    public async fastSyncIdeRules(
        @Body()
        body: {
            teamId: string;
            repositoryId: string;
            maxFiles?: number;
            maxFileSizeBytes?: number;
            maxTotalBytes?: number;
        },
    ) {
        return this.fastSyncIdeRulesUseCase.execute(body);
    }

    @ApiBearerAuth('jwt')
    @Get('/pending-ide-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'List pending IDE rules',
        description: 'Return pending IDE rules for a repository.',
    })
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @ApiQuery({ name: 'repositoryId', type: String, required: false })
    @ApiOkResponse({ type: ApiArrayResponseDto })
    public async listPendingIdeRules(
        @Query('teamId') teamId: string,
        @Query('repositoryId') repositoryId?: string,
    ) {
        const organizationId = this.request.user.organization.uuid;
        return this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
            organizationId,
            { status: KodyRulesStatus.PENDING },
            repositoryId,
        );
    }

    @ApiBearerAuth('jwt')
    @Post('/import-fast-ide-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Import fast IDE rules',
        description: 'Import rules from fast sync results.',
    })
    @ApiCreatedResponse({ type: KodyRulesArrayResponseDto })
    public async importFastIdeRules(@Body() body: ImportFastKodyRulesDto) {
        return this.importFastKodyRulesUseCase.execute(body);
    }

    @ApiBearerAuth('jwt')
    @Post('/review-fast-ide-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Review fast IDE rules',
        description: 'Activate or delete fast imported rules.',
    })
    @ApiCreatedResponse({ type: ApiObjectResponseDto })
    public async reviewFastIdeRules(@Body() body: ReviewFastKodyRulesDto) {
        const results: any = {};

        if (body.activateRuleIds?.length) {
            results.activated = await this.changeStatusKodyRulesUseCase.execute(
                {
                    ruleIds: body.activateRuleIds,
                    status: KodyRulesStatus.ACTIVE,
                },
            );
        }

        if (body.deleteRuleIds?.length) {
            results.deleted = await this.changeStatusKodyRulesUseCase.execute({
                ruleIds: body.deleteRuleIds,
                status: KodyRulesStatus.DELETED,
            });
        }

        return results;
    }

    @ApiBearerAuth('jwt')
    @Get('/inherited-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkRepoPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
            repo: {
                key: {
                    query: 'repositoryId',
                },
            },
        }),
    )
    @ApiOperation({
        summary: 'Get inherited rules',
        description: 'Return global and repository inherited rules.',
    })
    @ApiOkResponse({ type: KodyRulesInheritedResponseDto })
    public async getInheritedRules(
        @Query('teamId') teamId: string,
        @Query('repositoryId') repositoryId: string,
        @Query('directoryId') directoryId?: string,
    ) {
        if (!this.request.user.organization.uuid) {
            throw new Error('Organization ID not found');
        }

        if (!teamId) {
            throw new Error('Team ID is required');
        }

        if (!repositoryId) {
            throw new Error('Repository ID is required');
        }

        return this.getInheritedRulesKodyRulesUseCase.execute(
            {
                organizationId: this.request.user.organization.uuid,
                teamId,
            },
            repositoryId,
            directoryId,
        );
    }

    // NOT USED IN WEB - INTERNAL USE ONLY
    @ApiBearerAuth('jwt')
    @Post('/resync-ide-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.KodyRules,
        }),
    )
    @ApiOperation({
        summary: 'Resync IDE rules',
        description: 'Resync IDE rules (internal).',
    })
    @ApiNoContentResponse({ description: 'Resync started' })
    public async resyncIdeRules(
        @Body() body: { teamId: string; repositoryId: string },
    ) {
        const respositories = [body.repositoryId];

        return this.resyncRulesFromIdeUseCase.execute({
            teamId: body.teamId,
            repositoriesIds: respositories,
        });
    }
}
