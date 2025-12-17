import { UserRequest } from '@/config/types/http/user-request.type';
import { AddLibraryKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/add-library-kody-rules.use-case';
import { ChangeStatusKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/change-status-kody-rules.use-case';
import { CheckSyncStatusUseCase } from '@/core/application/use-cases/kodyRules/check-sync-status.use-case';
import { CreateOrUpdateKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/create-or-update.use-case';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/delete-rule-in-organization-by-id.use-case';
import { FindByOrganizationIdKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/find-by-organization-id.use-case';
import { FindLibraryKodyRulesBucketsUseCase } from '@/core/application/use-cases/kodyRules/find-library-kody-rules-buckets.use-case';
import { FindLibraryKodyRulesWithFeedbackUseCase } from '@/core/application/use-cases/kodyRules/find-library-kody-rules-with-feedback.use-case';
import { FindLibraryKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/find-library-kody-rules.use-case';
import { FindRecommendedKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/find-recommended-kody-rules.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/find-rules-in-organization-by-filter.use-case';
import { FindSuggestionsByRuleUseCase } from '@/core/application/use-cases/kodyRules/find-suggestions-by-rule.use-case';
import { GenerateKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/generate-kody-rules.use-case';
import { GetInheritedRulesKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/get-inherited-kody-rules.use-case';
import { GetRulesLimitStatusUseCase } from '@/core/application/use-cases/kodyRules/get-rules-limit-status.use-case';
import { ResyncRulesFromIdeUseCase } from '@/core/application/use-cases/kodyRules/resync-rules-from-ide.use-case';
import { SyncSelectedRepositoriesKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/sync-selected-repositories.use-case';
import { FastSyncIdeRulesUseCase } from '@/core/application/use-cases/kodyRules/fast-sync-ide-rules.use-case';
import { ImportFastKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/import-fast-kody-rules.use-case';
import { ImportFastKodyRulesDto } from '../dtos/import-fast-kody-rules.dto';
import { ReviewFastKodyRulesDto } from '../dtos/review-fast-kody-rules.dto';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import { KodyRulesStatus } from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import { CacheService } from '@/shared/utils/cache/cache.service';
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
    CheckPolicies,
    PolicyGuard,
} from '../../adapters/services/permissions/policy.guard';
import {
    checkPermissions,
    checkRepoPermissions,
} from '../../adapters/services/permissions/policy.handlers';
import { AddLibraryKodyRulesDto } from '../dtos/add-library-kody-rules.dto';
import { ChangeStatusKodyRulesDTO } from '../dtos/change-status-kody-rules.dto';
import { CreateKodyRuleDto } from '../dtos/create-kody-rule.dto';
import { FindLibraryKodyRulesDto } from '../dtos/find-library-kody-rules.dto';
import { FindRecommendedKodyRulesDto } from '../dtos/find-recommended-kody-rules.dto';
import { FindSuggestionsByRuleDto } from '../dtos/find-suggestions-by-rule.dto';
import { GenerateKodyRulesDTO } from '../dtos/generate-kody-rules.dto';

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
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Post('/create-or-update')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.KodyRules,
        }),
    )
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

    @Get('/find-by-organization-id')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
        }),
    )
    public async findByOrganizationId() {
        return this.findByOrganizationIdKodyRulesUseCase.execute();
    }

    @Get('/limits')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
        }),
    )
    public async getRulesLimitStatus() {
        return this.getRulesLimitStatusUseCase.execute();
    }

    @Get('/suggestions')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
        }),
    )
    public async findSuggestionsByRule(
        @Query() query: FindSuggestionsByRuleDto,
    ) {
        return this.findSuggestionsByRuleUseCase.execute(query.ruleId);
    }

    @Get('/find-rules-in-organization-by-filter')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
        }),
    )
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

    @Delete('/delete-rule-in-organization-by-id')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Delete,
            resource: ResourceType.KodyRules,
        }),
    )
    public async deleteRuleInOrganizationById(
        @Query('ruleId')
        ruleId: string,
    ) {
        return this.deleteRuleInOrganizationByIdKodyRulesUseCase.execute(
            ruleId,
        );
    }

    @Get('/find-library-kody-rules')
    public async findLibraryKodyRules(@Query() query: FindLibraryKodyRulesDto) {
        return this.findLibraryKodyRulesUseCase.execute(query);
    }

    @Get('/find-library-kody-rules-with-feedback')
    public async findLibraryKodyRulesWithFeedback(
        @Query() query: FindLibraryKodyRulesDto,
    ) {
        return this.findLibraryKodyRulesWithFeedbackUseCase.execute(query);
    }

    @Get('/find-library-kody-rules-buckets')
    public async findLibraryKodyRulesBuckets() {
        return this.findLibraryKodyRulesBucketsUseCase.execute();
    }

    @Get('/find-recommended-kody-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
        }),
    )
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

    @Post('/add-library-kody-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.KodyRules,
        }),
    )
    public async addLibraryKodyRules(@Body() body: AddLibraryKodyRulesDto) {
        return this.addLibraryKodyRulesUseCase.execute(body);
    }

    @Post('/generate-kody-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.KodyRules,
        }),
    )
    public async generateKodyRules(@Body() body: GenerateKodyRulesDTO) {
        if (!this.request.user.organization.uuid) {
            throw new Error('Organization ID not found');
        }

        return this.generateKodyRulesUseCase.execute(
            body,
            this.request.user.organization.uuid,
        );
    }

    @Post('/change-status-kody-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.KodyRules,
        }),
    )
    public async changeStatusKodyRules(@Body() body: ChangeStatusKodyRulesDTO) {
        return this.changeStatusKodyRulesUseCase.execute(body);
    }

    @Get('/check-sync-status')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
        }),
    )
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

        // Se não estiver no cache, executa o use case
        const result = await this.checkSyncStatusUseCase.execute(
            teamId,
            repositoryId,
        );

        // Salva no cache por 15 minutos
        await this.cacheService.addToCache(cacheKey, result, 900000); // 15 minutos em milissegundos

        return result;
    }

    @Post('/sync-ide-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.KodyRules,
        }),
    )
    public async syncIdeRules(
        @Body() body: { teamId: string; repositoryId: string },
    ) {
        const respositories = [body.repositoryId];

        return this.syncSelectedReposKodyRulesUseCase.execute({
            teamId: body.teamId,
            repositoriesIds: respositories,
        });
    }

    @Post('/fast-sync-ide-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.KodyRules,
        }),
    )
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

    @Get('/pending-ide-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.KodyRules,
        }),
    )
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

    @Post('/import-fast-ide-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.KodyRules,
        }),
    )
    public async importFastIdeRules(@Body() body: ImportFastKodyRulesDto) {
        return this.importFastKodyRulesUseCase.execute(body);
    }

    @Post('/review-fast-ide-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.KodyRules,
        }),
    )
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
    @Post('/resync-ide-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.KodyRules,
        }),
    )
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
