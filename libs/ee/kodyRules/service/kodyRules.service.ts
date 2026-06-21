import {
    BadRequestException,
    forwardRef,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { v4 } from 'uuid';
import bucketsData from './data/buckets.json';
import libraryKodyRules from './data/library-kody-rules.json';

import { createLogger } from '@kodus/flow';
import { CentralizedConfigPrService } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { ModuleRef } from '@nestjs/core';
import {
    buildKodyRuleCentralizedFilePath,
    buildKodyRuleCentralizedMutationRequest,
} from '@libs/centralized-config/utils/kody-rules-centralized-pr.builder';
import {
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import {
    kodyMemoryResolutionSchema,
    prompt_kodyMemoryResolution_system,
    prompt_kodyMemoryResolution_user,
} from '@libs/common/utils/langchainCommon/prompts/kodyMemoryResolution';
import { kodyRulesRecommendationSchema } from '@libs/common/utils/langchainCommon/prompts/kodyRulesRecommendation';
import { ProgrammingLanguage } from '@libs/core/domain/enums';
import {
    ActionType,
    UserInfo,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import {
    BucketInfo,
    KodyRuleFilters,
    LibraryKodyRule,
} from '@libs/core/infrastructure/config/types/general/kodyRules.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import {
    CreateKodyRuleDto,
    KodyRuleSeverity,
} from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import {
    IKodyRulesRepository,
    KODY_RULES_REPOSITORY_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.repository.contract';
import {
    CreateOrUpdateMemoryResult,
    IKodyRulesService,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    IRuleLikeService,
    RULE_LIKE_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/ruleLike.service.contract';
import { KodyRulesEntity } from '@libs/kodyRules/domain/entities/kodyRules.entity';
import {
    FindMemoriesFilters,
    FindMemoriesResult,
    IKodyRule,
    IKodyRuleMemory,
    IKodyRules,
    KodyRuleCentralizedStatus,
    KodyRuleRequestType,
    KodyRulesOrigin,
    KodyRulesScope,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import {
    IPullRequestsRepository,
    PULL_REQUESTS_REPOSITORY_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.repository';
import { KodyRulesValidationService } from './kody-rules-validation.service';
import { buildKodyRuleAppLink } from '../utils/build-rule-link';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@libs/core/domain/enums';
import {
    CodeReviewParameter,
    ICodeRepository,
    RepositoryCodeReviewConfig,
} from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';

@Injectable()
export class KodyRulesService implements IKodyRulesService {
    private readonly logger = createLogger(KodyRulesService.name);

    constructor(
        @Inject(KODY_RULES_REPOSITORY_TOKEN)
        private readonly kodyRulesRepository: IKodyRulesRepository,

        private readonly eventEmitter: EventEmitter2,

        @Inject(RULE_LIKE_SERVICE_TOKEN)
        private readonly ruleLikeService: IRuleLikeService,

        @Inject(PULL_REQUESTS_REPOSITORY_TOKEN)
        private readonly pullRequestsRepository: IPullRequestsRepository,

        private readonly kodyRulesValidationService: KodyRulesValidationService,

        private readonly mcpManagerService: MCPManagerService,

        private readonly promptRunnerService: PromptRunnerService,

        private readonly observabilityService: ObservabilityService,

        private readonly permissionValidationService: PermissionValidationService,

        // ModuleRef em vez de injetar CentralizedConfigPrService direto.
        // KodyRulesService ↔ CentralizedConfigPrService formam um ciclo
        // profundo, e CCP é request-scoped (transitivamente, via
        // codeManagementService). forwardRef nessa combinação produzia
        // um proxy vazio em runtime. moduleRef.resolve() resolve o
        // provider lazy, no contexto correto, sem precisar refatorar o
        // ciclo.
        private readonly moduleRef: ModuleRef,

        @Inject(forwardRef(() => CODE_BASE_CONFIG_SERVICE_TOKEN))
        private readonly codeBaseConfigService: ICodeBaseConfigService,
    ) {}

    // CCP é request-scoped (depende transitivamente de algo
    // request-scoped, provavelmente codeManagementService com token
    // multi-tenant). ModuleRef.get() não funciona com scoped providers
    // — precisa ser ModuleRef.resolve(), que é async e cria uma
    // instância no contexto atual de injeção.
    private async resolveCentralizedConfigPrService(): Promise<CentralizedConfigPrService> {
        return this.moduleRef.resolve(CentralizedConfigPrService, undefined, {
            strict: false,
        });
    }

    countRules(
        organizationId: string,
        status?: KodyRulesStatus,
    ): Promise<number> {
        throw new Error('Method not implemented.');
    }

    getNativeCollection() {
        throw new Error('Method not implemented.');
    }

    async create(
        kodyRules: Omit<IKodyRules, 'uuid'>,
    ): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.create(kodyRules);
    }

    async findById(uuid: string): Promise<IKodyRule | null> {
        return this.kodyRulesRepository.findById(uuid);
    }

    async findOne(
        filter?: Partial<IKodyRules>,
    ): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.findOne(filter);
    }

    async find(filter?: Partial<IKodyRules>): Promise<KodyRulesEntity[]> {
        const entities = await this.kodyRulesRepository.find(filter);

        return entities?.map((entity) => {
            const normalized = entity.toObject();
            normalized.rules = normalized.rules.map((rule) => ({
                ...rule,
                severity: rule.severity?.toLowerCase(),
            }));
            return KodyRulesEntity.create(normalized);
        });
    }

    async findByOrganizationId(
        organizationId: string,
    ): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.findByOrganizationId(organizationId);
    }

    /**
     * Obtém informações sobre limites de Kody Rules para uma organização
     * Usado pelo frontend para controlar UI (desabilitar botões, mostrar avisos, etc)
     */
    async getRulesLimitStatus(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{
        total: number;
    }> {
        try {
            // Count server-side via aggregation instead of loading the
            // entire rules array and filtering in JS. Orgs with 100s–
            // 1000s of rules saw the old path transfer 100KB+ of
            // embedded docs per request just to compute a single
            // number.
            const total = await this.kodyRulesRepository.countRules(
                organizationAndTeamData.organizationId,
                KodyRulesStatus.ACTIVE,
            );

            return { total };
        } catch (error) {
            this.logger.error({
                message: 'Error getting rules limit status',
                error: error,
                context: KodyRulesService.name,
                metadata: { organizationAndTeamData },
            });
            throw error;
        }
    }

    /**
     * Per-(repo, directory) rule counts for an organization, computed in a
     * single aggregation. Counts ACTIVE + PAUSED — the pool the user sees
     * in the list (mirrors `useKodyRulesCount` on the web). Drives the per
     * repository/directory count badges without fetching each repo's full
     * rules array (and running enrichment) once per card.
     */
    async countRulesByRepository(
        organizationId: string,
    ): Promise<
        Array<{
            repositoryId: string;
            directoryId: string | null;
            count: number;
        }>
    > {
        return this.kodyRulesRepository.countRulesByRepository(organizationId, [
            KodyRulesStatus.ACTIVE,
            KodyRulesStatus.PAUSED,
        ]);
    }

    /**
     * Busca rules específicas por organização, repositório e diretório
     * Versão simplificada que filtra in-memory
     */
    async findRulesByDirectory(
        organizationId: string,
        repositoryId: string,
        directoryId: string,
        type?: KodyRulesType,
    ): Promise<Partial<IKodyRule>[]> {
        const entity = await this.findByOrganizationId(organizationId);

        if (!entity?.toObject()?.rules) {
            return [];
        }

        return entity
            .toObject()
            .rules.filter(
                (rule) =>
                    (type ? rule.type === type : true) &&
                    rule.repositoryId === repositoryId &&
                    rule.directoryId === directoryId &&
                    rule.status === KodyRulesStatus.ACTIVE,
            );
    }

    async update(
        uuid: string,
        updateData: Partial<IKodyRules>,
    ): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.update(uuid, updateData);
    }

    async delete(uuid: string): Promise<boolean> {
        return this.kodyRulesRepository.delete(uuid);
    }

    async addRule(
        uuid: string,
        newRule: Partial<IKodyRule>,
    ): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.addRule(uuid, newRule);
    }

    async updateRule(
        uuid: string,
        ruleId: string,
        updateData: Partial<IKodyRule>,
    ): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.updateRule(uuid, ruleId, updateData);
    }

    async createOrUpdate(
        organizationAndTeamData: OrganizationAndTeamData,
        kodyRule: CreateKodyRuleDto,
        userInfo: UserInfo,
    ): Promise<Partial<IKodyRule> | IKodyRule | null> {
        const existing = await this.findByOrganizationId(
            organizationAndTeamData.organizationId,
        );

        // The new rule only consumes plan quota if it lands ACTIVE — quota
        // counts ACTIVE only (see the gate in the existing-doc branch and
        // getRulesLimitStatus). A rule created paused/pending doesn't count.
        const newRuleCountsTowardQuota =
            (kodyRule?.status ?? KodyRulesStatus.ACTIVE) ===
            KodyRulesStatus.ACTIVE;

        // If no rules exist for the organization
        if (!existing) {
            if (kodyRule.uuid) {
                throw new NotFoundException('Rule not found');
            }

            await this.ensureFreePlanLimit(
                organizationAndTeamData,
                newRuleCountsTowardQuota ? 1 : 0,
            );

            const newRule: IKodyRule = {
                uuid: v4(),
                type: kodyRule?.type ?? KodyRulesType.STANDARD,
                title: kodyRule?.title,
                rule: kodyRule?.rule,
                path: kodyRule?.path,
                severity: kodyRule?.severity?.toLowerCase(),
                status: kodyRule?.status ?? KodyRulesStatus.ACTIVE,
                sourcePath: kodyRule?.sourcePath,
                centralizedConfig: kodyRule?.centralizedConfig,
                sourceAnchor: kodyRule?.sourceAnchor,
                repositoryId: kodyRule?.repositoryId,
                directoryId: kodyRule?.directoryId,
                examples: kodyRule?.examples,
                origin: kodyRule?.origin ?? KodyRulesOrigin.USER,
                scope: kodyRule?.scope ?? KodyRulesScope.FILE,
                inheritance: {
                    inheritable: kodyRule?.inheritance?.inheritable ?? true,
                    exclude: kodyRule?.inheritance?.exclude ?? [],
                    include: kodyRule?.inheritance?.include ?? [],
                },
                requestType: kodyRule?.requestType,
                targetRuleUuid: kodyRule?.targetRuleUuid,
                resolvedAt: kodyRule?.resolvedAt,
                resolvedBy: kodyRule?.resolvedBy,
                pinnedSync: kodyRule?.pinnedSync,
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            const newKodyRules = await this.create({
                organizationId: organizationAndTeamData.organizationId,
                rules: [newRule],
            });

            if (!newKodyRules) {
                throw new Error(
                    'Could not create new Kody rules for organization',
                );
            }

            this.eventEmitter.emit(AuditLogEvents.KODY_RULES, {
                organizationAndTeamData,
                userInfo,
                actionType:
                    newRule.origin === KodyRulesOrigin.LIBRARY
                        ? ActionType.CLONE
                        : ActionType.CREATE,
                repository: { id: newRule.repositoryId },
                oldRule: undefined,
                newRule: newRule,
                ruleTitle: newRule.title,
            });

            await this.ensureRepositoryCodeReviewConfig(
                organizationAndTeamData,
                newRule,
            );

            return newKodyRules.rules[0];
        }

        // If there is no UUID, it is a new rule
        if (!kodyRule.uuid) {
            // Count ACTIVE only, matching the `/limits` endpoint
            // (getRulesLimitStatus → countRules(ACTIVE)). Counting
            // `!== DELETED` also counts PAUSED/PENDING rules the UI never
            // shows against the quota, so the UI says "add away" while this
            // gate rejects. Paused/pending rules aren't enforced and don't
            // consume plan quota. The +1 is conditional: a rule created
            // already paused/pending doesn't add to the active count.
            const activeRulesCount = (existing.rules ?? []).filter(
                (r) => r.status === KodyRulesStatus.ACTIVE,
            ).length;
            await this.ensureFreePlanLimit(
                organizationAndTeamData,
                activeRulesCount + (newRuleCountsTowardQuota ? 1 : 0),
            );

            const newRule: IKodyRule = {
                uuid: v4(),
                type: kodyRule.type,
                title: kodyRule.title,
                rule: kodyRule.rule,
                path: kodyRule.path,
                sourcePath: kodyRule.sourcePath,
                centralizedConfig: kodyRule.centralizedConfig,
                sourceAnchor: kodyRule.sourceAnchor,
                severity: kodyRule.severity?.toLowerCase(),
                status: kodyRule.status ?? KodyRulesStatus.ACTIVE,
                repositoryId: kodyRule?.repositoryId,
                directoryId: kodyRule?.directoryId,
                examples: kodyRule?.examples,
                origin: kodyRule?.origin,
                scope: kodyRule?.scope ?? KodyRulesScope.FILE,
                inheritance: {
                    inheritable: kodyRule?.inheritance?.inheritable ?? true,
                    exclude: kodyRule?.inheritance?.exclude ?? [],
                    include: kodyRule?.inheritance?.include ?? [],
                },
                requestType: kodyRule?.requestType,
                targetRuleUuid: kodyRule?.targetRuleUuid,
                resolvedAt: kodyRule?.resolvedAt,
                resolvedBy: kodyRule?.resolvedBy,
                pinnedSync: kodyRule?.pinnedSync,
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            const updatedKodyRules = await this.addRule(existing.uuid, newRule);

            if (!updatedKodyRules) {
                throw new Error('Could not add new rule');
            }

            this.eventEmitter.emit(AuditLogEvents.KODY_RULES, {
                organizationAndTeamData,
                userInfo,
                actionType:
                    newRule.origin === KodyRulesOrigin.LIBRARY
                        ? ActionType.CLONE
                        : ActionType.CREATE,
                repository: { id: newRule.repositoryId },
                directory: { id: newRule.directoryId },
                oldRule: undefined,
                newRule: newRule,
                ruleTitle: newRule.title,
            });

            await this.ensureRepositoryCodeReviewConfig(
                organizationAndTeamData,
                newRule,
            );

            return updatedKodyRules.rules.find(
                (rule) => rule.uuid === newRule.uuid,
            );
        }

        // If there is a UUID, it is an update
        const existingRule = existing?.rules?.find(
            (rule) => rule.uuid === kodyRule.uuid,
        );

        if (!existingRule) {
            throw new NotFoundException('Rule not found');
        }

        // When unpausing (changing from non-ACTIVE to ACTIVE), enforce the
        // free-plan quota so the user can't bypass the 10-rule limit by
        // pausing and creating new rules.
        if (
            kodyRule.status === KodyRulesStatus.ACTIVE &&
            existingRule.status !== KodyRulesStatus.ACTIVE
        ) {
            const activeRulesCount = (existing.rules ?? []).filter(
                (r) => r.status === KodyRulesStatus.ACTIVE,
            ).length;
            await this.ensureFreePlanLimit(
                organizationAndTeamData,
                activeRulesCount + 1,
            );
        }

        // Normalize severity on the way in (create/addRule already do this);
        // otherwise an update could persist a mixed-case severity that only
        // looks consistent because find() lower-cases on read.
        const mergedSeverity = (
            kodyRule.severity ?? existingRule.severity
        )?.toLowerCase();

        const updatedRule = {
            ...existingRule,
            ...kodyRule,
            ...(mergedSeverity ? { severity: mergedSeverity } : {}),
            updatedAt: new Date(),
        };

        const updatedKodyRules = await this.updateRule(
            existing.uuid,
            kodyRule.uuid,
            updatedRule,
        );

        this.eventEmitter.emit(AuditLogEvents.KODY_RULES, {
            organizationAndTeamData,
            userInfo: userInfo || {
                userId: 'kody-system',
                userEmail: 'kody@kodus.io',
            },
            actionType: ActionType.EDIT,
            repository: { id: updatedRule.repositoryId },
            directory: { id: updatedRule.directoryId },
            oldRule: existingRule,
            newRule: updatedRule,
            ruleTitle: updatedRule.title,
        });

        if (!updatedKodyRules) {
            throw new Error('Could not update rule');
        }

        return updatedKodyRules.rules.find(
            (rule) => rule.uuid === kodyRule.uuid,
        );
    }

    private async ensureRepositoryCodeReviewConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        rule: Partial<IKodyRule>,
    ): Promise<void> {
        if (
            rule.origin === KodyRulesOrigin.USER ||
            !rule.repositoryId ||
            rule.repositoryId === 'global'
        ) {
            return;
        }

        let parametersService: IParametersService;
        let integrationConfigService: IIntegrationConfigService;
        try {
            parametersService = this.moduleRef.get(PARAMETERS_SERVICE_TOKEN, {
                strict: false,
            });
            integrationConfigService = this.moduleRef.get(
                INTEGRATION_CONFIG_SERVICE_TOKEN,
                { strict: false },
            );
        } catch {
            return;
        }

        try {
            const codeReviewConfig =
                await parametersService.findByKey(
                    ParametersKey.CODE_REVIEW_CONFIG,
                    organizationAndTeamData,
                );

            if (!codeReviewConfig?.configValue) {
                return;
            }

            const configValue =
                codeReviewConfig.configValue as CodeReviewParameter;
            const repositories = configValue.repositories || [];

            if (repositories.some((r) => r.id === rule.repositoryId)) {
                return;
            }

            let repositoryName = rule.repositoryId;
            try {
                const repos =
                    await integrationConfigService.findIntegrationConfigFormatted<
                        ICodeRepository[]
                    >(
                        IntegrationConfigKey.REPOSITORIES,
                        organizationAndTeamData,
                    );

                const matched = repos?.find(
                    (r) => r.id === rule.repositoryId,
                );
                if (matched?.name) {
                    repositoryName = matched.name;
                }
            } catch {
                // fallback: use repositoryId as name
            }

            const newRepo: RepositoryCodeReviewConfig = {
                id: rule.repositoryId,
                name: repositoryName,
                isSelected: true,
                configs: {},
            };

            const updatedConfigValue: CodeReviewParameter = {
                ...configValue,
                repositories: [...repositories, newRepo],
            };

            await parametersService.createOrUpdateConfig(
                ParametersKey.CODE_REVIEW_CONFIG,
                updatedConfigValue,
                organizationAndTeamData,
            );
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to auto-create repository config for auto-generated rule',
                context: KodyRulesService.name,
                error,
                metadata: {
                    repositoryId: rule.repositoryId,
                    ruleId: rule.uuid,
                    ruleOrigin: rule.origin,
                    organizationAndTeamData,
                },
            });
        }
    }

    async updateRuleReferences(
        organizationId: string,
        ruleId: string,
        references: {
            contextReferenceId?: string;
            // Todos os outros campos de referência foram movidos para Context OS
        },
    ): Promise<IKodyRule | null> {
        this.logger.log({
            message: 'KodyRulesService.updateRuleReferences called',
            context: KodyRulesService.name,
            metadata: {
                organizationId,
                ruleId,
                contextReferenceId: references.contextReferenceId,
                strategy: 'context-os-only', // Todos os campos de referência ficam no Context OS
            },
        });

        const existing = await this.findByOrganizationId(organizationId);

        if (!existing) {
            throw new NotFoundException(
                'Kody rules not found for organization',
            );
        }

        const existingRule = existing.rules?.find(
            (rule) => rule.uuid === ruleId,
        );

        if (!existingRule) {
            throw new NotFoundException('Rule not found');
        }

        const updatedRule = {
            ...existingRule,
            contextReferenceId: references.contextReferenceId,
            // Todos os outros campos de referência foram movidos para Context OS
            updatedAt: new Date(),
        } as IKodyRule;

        const updatedKodyRules = await this.updateRule(
            existing.uuid,
            ruleId,
            updatedRule,
        );

        if (!updatedKodyRules) {
            this.logger.error({
                message: 'Could not update rule references',
                error: new Error('Could not update rule references'),
                context: KodyRulesService.name,
                metadata: {
                    organizationId,
                    ruleId,
                    references,
                },
            });
            throw new Error('Could not update rule references');
        }

        const updatedRuleResult = updatedKodyRules.rules.find(
            (rule) => rule.uuid === ruleId,
        );

        return updatedRuleResult ? (updatedRuleResult as IKodyRule) : null;
    }

    async updateRuleWithLogging(
        organizationAndTeamData: OrganizationAndTeamData,
        kodyRule: CreateKodyRuleDto,
        userInfo?: UserInfo,
    ): Promise<Partial<IKodyRule> | IKodyRule | null> {
        const existing = await this.findByOrganizationId(
            organizationAndTeamData.organizationId,
        );

        if (!existing) {
            throw new NotFoundException('Organization rules not found');
        }

        const existingRule = existing.rules.find(
            (rule) => rule.uuid === kodyRule.uuid,
        );

        if (!existingRule) {
            throw new NotFoundException('Rule not found');
        }

        // Normalize severity on the way in (create/addRule already do this);
        // otherwise an update could persist a mixed-case severity that only
        // looks consistent because find() lower-cases on read.
        const mergedSeverity = (
            kodyRule.severity ?? existingRule.severity
        )?.toLowerCase();

        const updatedRule = {
            ...existingRule,
            ...kodyRule,
            ...(mergedSeverity ? { severity: mergedSeverity } : {}),
            updatedAt: new Date(),
        };

        const updatedKodyRules = await this.updateRule(
            existing.uuid,
            kodyRule.uuid,
            updatedRule,
        );

        this.eventEmitter.emit(AuditLogEvents.KODY_RULES, {
            organizationAndTeamData,
            userInfo: userInfo || {
                userId: 'kody-system',
                userEmail: 'kody@kodus.io',
            },
            actionType: ActionType.EDIT,
            repository: { id: updatedRule.repositoryId },
            directory: { id: updatedRule.directoryId },
            oldRule: existingRule,
            newRule: updatedRule,
            ruleTitle: updatedRule.title,
        });

        if (!updatedKodyRules) {
            throw new Error('Could not update rule');
        }

        return updatedKodyRules.rules.find(
            (rule) => rule.uuid === kodyRule.uuid,
        );
    }

    async deleteRule(uuid: string, ruleId: string): Promise<boolean> {
        return this.kodyRulesRepository.deleteRule(uuid, ruleId);
    }

    async updateRulesStatusByFilter(
        organizationId: string,
        repositoryId: string,
        directoryId?: string,
        newStatus: KodyRulesStatus = KodyRulesStatus.DELETED,
    ): Promise<KodyRulesEntity | null> {
        try {
            const result =
                await this.kodyRulesRepository.updateRulesStatusByFilter(
                    organizationId,
                    repositoryId,
                    directoryId,
                    newStatus,
                );

            if (result) {
                this.logger.log({
                    message: 'Kody rules status updated successfully by filter',
                    context: KodyRulesService.name,
                    metadata: {
                        organizationId,
                        repositoryId,
                        directoryId,
                        newStatus,
                    },
                });
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error updating Kody rules status by filter',
                context: KodyRulesService.name,
                error: error,
                metadata: {
                    organizationId,
                    repositoryId,
                    directoryId,
                    newStatus,
                },
            });
            throw error;
        }
    }

    async deleteRuleLogically(
        uuid: string,
        ruleId: string,
    ): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.deleteRuleLogically(uuid, ruleId);
    }

    async deleteRuleWithLogging(
        organizationAndTeamData: OrganizationAndTeamData,
        ruleId: string,
        userInfo: UserInfo,
    ): Promise<boolean> {
        try {
            const existing = await this.findByOrganizationId(
                organizationAndTeamData.organizationId,
            );

            if (!existing?.rules?.length) {
                return false;
            }

            const deletedRule = existing.rules.find(
                (rule) => rule.uuid === ruleId,
            );
            if (!deletedRule) {
                return false;
            }

            const rule = await this.deleteRuleLogically(existing.uuid, ruleId);

            this.eventEmitter.emit(AuditLogEvents.KODY_RULES, {
                organizationAndTeamData,
                userInfo,
                actionType: ActionType.DELETE,
                repository: { id: deletedRule.repositoryId },
                oldRule: deletedRule,
                newRule: undefined,
                ruleTitle: deletedRule.title,
            });

            return !!rule;
        } catch (error) {
            this.logger.error({
                message: 'Error deleting rule with logging',
                error: error,
                context: KodyRulesService.name,
                metadata: {
                    ...organizationAndTeamData,
                    ruleId,
                    userInfo,
                },
            });
            throw error;
        }
    }

    private async ensureFreePlanLimit(
        organizationAndTeamData: OrganizationAndTeamData,
        totalRulesAfterOperation: number,
    ) {
        if (!organizationAndTeamData?.organizationId) {
            return;
        }

        try {
            const validation =
                await this.kodyRulesValidationService.validateRulesLimit(
                    organizationAndTeamData,
                    totalRulesAfterOperation,
                );

            if (!validation) {
                throw new BadRequestException(
                    `Free plan's limit of Kody Rules reached.`,
                );
            }
        } catch (error) {
            if (error instanceof BadRequestException) {
                throw error;
            }

            this.logger.error({
                message:
                    'Error validating Kody Rules limit - blocking operation for safety',
                error: error,
                context: KodyRulesService.name,
                metadata: {
                    organizationAndTeamData,
                    totalRulesAfterOperation,
                },
            });

            throw new BadRequestException(
                `Unable to validate rules limit. Please try again later.`,
            );
        }
    }

    private addLanguageToRule(
        kodyRule: LibraryKodyRule,
        language: ProgrammingLanguage,
    ): LibraryKodyRule & { language: ProgrammingLanguage } {
        // Returns only the necessary fields
        return {
            uuid: kodyRule.uuid,
            title: kodyRule.title,
            rule: kodyRule.rule,
            why_is_this_important: kodyRule.why_is_this_important,
            severity: kodyRule.severity,
            tags: kodyRule.tags,
            examples: kodyRule.examples || [],
            language,
        };
    }

    async getLibraryKodyRules(
        filters?: KodyRuleFilters,
        userId?: string,
    ): Promise<LibraryKodyRule[]> {
        return this.getLibraryKodyRulesInternal(filters, userId, false);
    }

    async getLibraryKodyRulesWithFeedback(
        filters?: KodyRuleFilters,
        userId?: string,
    ): Promise<LibraryKodyRule[]> {
        return this.getLibraryKodyRulesInternal(filters, userId, true);
    }

    private async getLibraryKodyRulesInternal(
        filters?: KodyRuleFilters,
        userId?: string,
        includeFeedback: boolean = false,
    ): Promise<LibraryKodyRule[]> {
        try {
            // Nova estrutura é um array direto
            if (!Array.isArray(libraryKodyRules)) {
                return [];
            }

            const validRules = libraryKodyRules
                .filter(
                    (rule) => rule && typeof rule === 'object' && rule.title,
                )
                .map((rule: any) => {
                    return {
                        ...rule,
                        buckets: rule.buckets || [],
                        type: KodyRulesType.STANDARD,
                    };
                });

            // Aplica filtros se houver
            let filteredRules = validRules;
            if (filters) {
                filteredRules = validRules.filter((rule) => {
                    // Filtro por título
                    if (
                        filters.title &&
                        !rule.title
                            .toLowerCase()
                            .includes(filters.title.toLowerCase())
                    ) {
                        return false;
                    }

                    // Filtro por severidade
                    if (
                        filters.severity &&
                        rule.severity?.toLowerCase() !==
                            filters.severity?.toLowerCase()
                    ) {
                        return false;
                    }

                    // Filtro por tags
                    if (filters.tags && filters.tags.length > 0) {
                        const ruleTags = rule.tags || [];
                        const hasMatchingTag = filters.tags.some((filterTag) =>
                            ruleTags.some((ruleTag) =>
                                ruleTag
                                    .toLowerCase()
                                    .includes(filterTag.toLowerCase()),
                            ),
                        );
                        if (!hasMatchingTag) {
                            return false;
                        }
                    }

                    // Filtro por linguagem
                    if (filters.language) {
                        const filterLanguage = String(
                            filters.language,
                        ).toLowerCase();
                        const ruleLanguage = String(
                            rule.language || '',
                        ).toLowerCase();

                        // Rules sem linguagem são consideradas "agnósticas" e passam no filtro
                        if (ruleLanguage && ruleLanguage !== filterLanguage) {
                            return false;
                        }
                    }

                    // Filtro por buckets
                    if (filters.buckets && filters.buckets.length > 0) {
                        const ruleBuckets = rule.buckets || [];
                        const hasMatchingBucket = filters.buckets.some(
                            (filterBucket) =>
                                ruleBuckets.includes(filterBucket),
                        );
                        if (!hasMatchingBucket) {
                            return false;
                        }
                    }

                    // Filtro por plug_and_play
                    if (
                        filters.plug_and_play !== undefined &&
                        filters.plug_and_play !== null
                    ) {
                        if (rule.plug_and_play !== filters.plug_and_play) {
                            return false;
                        }
                    }

                    // Filtro por needMCPS (required_mcps)
                    if (filters.needMCPS === true) {
                        const hasRequiredMcps =
                            Array.isArray(rule.required_mcps) &&
                            rule.required_mcps.length > 0;

                        if (!hasRequiredMcps) {
                            return false;
                        }
                    }

                    return true;
                });
            }

            // Se deve incluir feedback, busca dados de feedback
            if (includeFeedback) {
                try {
                    const feedbackData =
                        await this.ruleLikeService.getAllRulesWithFeedback(
                            userId,
                        );

                    const feedbackMap = new Map(
                        feedbackData.map((f) => [f.ruleId, f]),
                    );

                    return filteredRules.map((rule) => {
                        const feedback = feedbackMap.get(rule.uuid);
                        return {
                            ...rule,
                            positiveCount: feedback?.positiveCount || 0,
                            negativeCount: feedback?.negativeCount || 0,
                            // Só inclui userFeedback se userId foi fornecido
                            userFeedback: userId
                                ? feedback?.userFeedback || null
                                : null,
                        };
                    });
                } catch (error) {
                    this.logger.error({
                        message: 'Error fetching feedback data',
                        error: error,
                        context: KodyRulesService.name,
                        metadata: {
                            userId,
                            includeFeedback,
                        },
                    });
                    // Se erro ao buscar feedback, retorna sem feedback
                    return filteredRules;
                }
            }

            return filteredRules;
        } catch (error) {
            this.logger.error({
                message: 'Error in getLibraryKodyRules',
                error: error,
                context: KodyRulesService.name,
                metadata: {
                    filters,
                    userId,
                    includeFeedback,
                },
            });
            return [];
        }
    }

    async getLibraryKodyRulesBuckets(): Promise<BucketInfo[]> {
        try {
            if (!Array.isArray(bucketsData)) {
                return [];
            }

            // Create a map of rule counts per bucket for better performance O(M+N)
            const bucketRuleCounts = libraryKodyRules.reduce(
                (acc, rule: LibraryKodyRule) => {
                    if (rule.buckets?.length) {
                        rule.buckets.forEach((bucketSlug: string) => {
                            acc.set(bucketSlug, (acc.get(bucketSlug) || 0) + 1);
                        });
                    }
                    return acc;
                },
                new Map<string, number>(),
            );

            const bucketsWithCount: BucketInfo[] = bucketsData.map(
                (bucket) => ({
                    slug: bucket.slug,
                    title: bucket.title,
                    description: bucket.description,
                    rulesCount: bucketRuleCounts.get(bucket.slug) || 0,
                }),
            );

            return bucketsWithCount;
        } catch (error) {
            this.logger.error({
                message: 'Error in getLibraryKodyRulesBuckets',
                error: error,
                context: KodyRulesService.name,
            });
            return [];
        }
    }

    async getRecommendedRulesByMCP(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<LibraryKodyRule[]> {
        try {
            const mcpConnections = await this.mcpManagerService.getConnections(
                organizationAndTeamData,
                false,
            );

            if (!mcpConnections || mcpConnections.length === 0) {
                return [];
            }

            const installedMCPs = mcpConnections.map((conn) => conn.appName);

            const eligibleRules = (
                libraryKodyRules as LibraryKodyRule[]
            ).filter((rule) => {
                if (!rule.required_mcps || rule.required_mcps.length === 0) {
                    return false;
                }

                return rule.required_mcps.some((mcp) =>
                    installedMCPs.some((installedMCP) =>
                        installedMCP.toLowerCase().includes(mcp.toLowerCase()),
                    ),
                );
            });

            return eligibleRules;
        } catch (error) {
            this.logger.error({
                message: 'Error in getRecommendedRulesByMCP',
                error: error,
                context: KodyRulesService.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            return [];
        }
    }

    async getRecommendedRulesBySuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
        repoLanguage?: string,
    ): Promise<LibraryKodyRule[]> {
        try {
            const recentPRs =
                await this.pullRequestsRepository.findRecentByRepositoryId(
                    organizationAndTeamData.organizationId,
                    repositoryId,
                    10,
                );

            if (!recentPRs || recentPRs.length === 0) {
                this.logger.log({
                    message: 'No recent PRs found for recommendations',
                    context: KodyRulesService.name,
                    metadata: {
                        organizationId: organizationAndTeamData.organizationId,
                        repositoryId,
                    },
                });
                return [];
            }

            const allSuggestions = recentPRs
                .flatMap((pr) => {
                    const prObj = pr.toObject();
                    return (
                        prObj.files?.flatMap(
                            (file) =>
                                file.suggestions?.map((suggestion) => ({
                                    label: suggestion.label,
                                    severity: suggestion.severity,
                                    suggestionContent:
                                        suggestion.suggestionContent,
                                    oneSentenceSummary:
                                        suggestion.oneSentenceSummary,
                                })) || [],
                        ) || []
                    );
                })
                .filter(Boolean)
                .slice(0, 50);

            if (allSuggestions.length === 0) {
                this.logger.log({
                    message: 'No suggestions found in recent PRs',
                    context: KodyRulesService.name,
                    metadata: {
                        organizationId: organizationAndTeamData.organizationId,
                        repositoryId,
                    },
                });
                return [];
            }

            const filteredLibrary = (libraryKodyRules as LibraryKodyRule[])
                .filter((rule) => {
                    if (!repoLanguage)
                        return !rule.language || rule.language === '';
                    return (
                        !rule.language ||
                        rule.language === '' ||
                        rule.language === repoLanguage
                    );
                })
                .map((rule) => ({
                    uuid: rule.uuid,
                    title: rule.title,
                    rule: rule.rule,
                    buckets: rule.buckets,
                    severity: rule.severity,
                }));

            const byokConfigValue =
                await this.permissionValidationService.getBYOKConfig(
                    organizationAndTeamData,
                );

            const mainProvider = LLMModelProvider.GROQ_MOONSHOTAI_KIMI_K2_;
            const mainFallback = LLMModelProvider.GROQ_GPT_OSS_120B;
            const mainRun = 'kodyRulesRecommendationFromSuggestions';

            const promptRunner = new BYOKPromptRunnerService(
                this.promptRunnerService,
                mainProvider,
                mainFallback,
                byokConfigValue,
            );

            const systemPrompt = `You are a code quality expert analyzing past code review suggestions to recommend relevant Kody Rules.

## What are Kody Rules?
Kody Rules are reusable code review guidelines that help enforce best practices. Each rule has:
- title: Short descriptive name
- rule: The guideline to follow
- buckets: Categories like "error-handling", "security-hardening", "maintainability"
- severity: low | medium | high | critical
- language: Programming language (empty = language-agnostic)

## Your Task
Analyze the provided code review suggestions and identify PATTERNS of issues.
Then recommend rules from the library that would help prevent these patterns.

## Important Guidelines
1. Look for RECURRING patterns, not one-off issues
2. Recommend rules that address the ROOT CAUSE, not symptoms
3. Prefer rules with higher severity (critical/high) when relevant
4. Maximum 7 recommendations
5. Each recommendation needs a clear reason explaining the pattern you identified

## Output Format
Return ONLY a JSON object (no markdown, no code fences):
{
  "recommendations": [
    {
      "uuid": "rule-uuid-from-library",
      "reason": "Pattern identified: X. This rule helps because Y.",
      "relevanceScore": 8
    }
  ]
}`;

            const userPrompt = `## Recent Code Review Suggestions (patterns to analyze):
${JSON.stringify(allSuggestions)}

## Available Rules Library (filtered by language):
${JSON.stringify(filteredLibrary)}

Analyze the suggestions and recommend the most relevant rules.`;

            const { result } = await this.observabilityService.runLLMInSpan({
                spanName: `${KodyRulesService.name}::${mainRun}`,
                runName: mainRun,
                attrs: {
                    repositoryId,
                    organizationId: organizationAndTeamData.organizationId,
                    suggestionsCount: allSuggestions.length,
                    libraryRulesCount: filteredLibrary.length,
                    type: promptRunner.executeMode,
                },
                byokConfig: byokConfigValue,
                exec: async (callbacks) => {
                    return await promptRunner
                        .builder()
                        .setParser(
                            ParserType.ZOD,
                            kodyRulesRecommendationSchema,
                            {
                                provider: LLMModelProvider.GEMINI_2_5_FLASH,
                                fallbackProvider:
                                    LLMModelProvider.OPENAI_GPT_4O,
                            },
                        )
                        .setLLMJsonMode(true)
                        .setPayload({
                            repositoryId,
                            organizationId:
                                organizationAndTeamData.organizationId,
                        })
                        .addPrompt({
                            role: PromptRole.SYSTEM,
                            prompt: systemPrompt,
                        })
                        .addPrompt({
                            role: PromptRole.USER,
                            prompt: userPrompt,
                        })
                        .addCallbacks(callbacks)
                        .addMetadata({ runName: mainRun })
                        .setRunName(mainRun)
                        .execute();
                },
            });

            if (
                !result?.recommendations ||
                result.recommendations.length === 0
            ) {
                return [];
            }

            const recommendedUUIDs = result.recommendations.map((r) => r.uuid);
            const recommendedRules = (
                libraryKodyRules as LibraryKodyRule[]
            ).filter((rule) => recommendedUUIDs.includes(rule.uuid));

            return recommendedRules;
        } catch (error) {
            this.logger.error({
                message: 'Error in getRecommendedRulesBySuggestions',
                error: error,
                context: KodyRulesService.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    repositoryId,
                },
            });
            return [];
        }
    }

    async createOrUpdateMemory(
        organizationAndTeamData: OrganizationAndTeamData,
        memory: IKodyRuleMemory,
        userInfo?: UserInfo,
    ): Promise<CreateOrUpdateMemoryResult | null> {
        try {
            const resolution = await this.resolveGeneratedMemoryAction(
                organizationAndTeamData,
                memory,
            );

            if (resolution?.action === 'skip' && resolution.existingMemory) {
                return {
                    rule: resolution.existingMemory,
                    action: 'skipped',
                    requiresApproval: false,
                    link: this.buildMemoryLink(
                        resolution.existingMemory.repositoryId,
                        resolution.existingMemory.uuid,
                        organizationAndTeamData.teamId,
                        resolution.existingMemory.status,
                    ),
                };
            }

            const memoryToPersist =
                resolution && resolution.action !== 'skip'
                    ? resolution.memoryToPersist
                    : memory;

            const requiresApproval =
                await this.shouldRequireApprovalForGeneratedMemory(
                    organizationAndTeamData,
                    memoryToPersist,
                );

            const targetMemory =
                resolution?.action === 'update'
                    ? resolution.targetMemory
                    : null;
            const isTargetUserOrigin =
                targetMemory?.origin === KodyRulesOrigin.USER;
            const isTargetGeneratedNeedsApproval =
                targetMemory?.origin === KodyRulesOrigin.GENERATED &&
                requiresApproval;

            if (
                targetMemory?.uuid &&
                (isTargetUserOrigin || isTargetGeneratedNeedsApproval)
            ) {
                return await this.createPendingRequest(
                    organizationAndTeamData,
                    memoryToPersist,
                    userInfo,
                    KodyRuleRequestType.MEMORY_UPDATE,
                    targetMemory.uuid,
                );
            }

            if (requiresApproval && !memoryToPersist.uuid) {
                return await this.createPendingRequest(
                    organizationAndTeamData,
                    memoryToPersist,
                    userInfo,
                    KodyRuleRequestType.MEMORY_CREATE,
                );
            }

            const operation =
                resolution?.action === 'update' ? 'update' : 'create';

            const { rule, linkOverride } =
                await this.createOrUpdateMemoryWithCentralizedRouting(
                    organizationAndTeamData,
                    memoryToPersist,
                    userInfo,
                    operation,
                    requiresApproval,
                );

            if (!rule) return null;

            const action =
                operation === 'update'
                    ? ('updated' as const)
                    : ('created' as const);

            return {
                rule,
                action,
                requiresApproval,
                link:
                    linkOverride ||
                    this.buildMemoryLink(
                        rule.repositoryId,
                        rule.uuid,
                        organizationAndTeamData.teamId,
                        rule.status,
                    ),
            };
        } catch (error) {
            this.logger.error({
                message: 'Error in createOrUpdateMemory',
                error: error,
                context: KodyRulesService.name,
                metadata: {
                    organizationAndTeamData,
                    memory,
                    userInfo,
                },
            });
            throw error;
        }
    }

    private async createOrUpdateMemoryWithCentralizedRouting(
        organizationAndTeamData: OrganizationAndTeamData,
        memory: IKodyRuleMemory,
        userInfo: UserInfo | undefined,
        operation: 'create' | 'update',
        requiresApproval: boolean,
    ): Promise<{
        rule: Partial<IKodyRule> | IKodyRule | null;
        linkOverride?: string;
    }> {
        const payload = {
            ...this.getBaseMemoryPayload(memory),
            status: requiresApproval
                ? KodyRulesStatus.PENDING
                : memory.status || KodyRulesStatus.ACTIVE,
        };

        const ccp = await this.resolveCentralizedConfigPrService();
        const memoryGroupFolderName =
            await ccp.resolveDirectoryGroupFolderName(
                organizationAndTeamData,
                payload.repositoryId,
                payload.directoryId,
            );
        const centralizedPr = await ccp.createMutationPullRequestIfEnabled(
            buildKodyRuleCentralizedMutationRequest({
                centralizedConfigPrService: ccp,
                organizationAndTeamData,
                repositoryId: payload.repositoryId,
                groupFolderName: memoryGroupFolderName ?? undefined,
                ruleContent: payload,
                ruleType: KodyRulesType.MEMORY,
                operation,
            }),
        );

        if (centralizedPr.mode !== 'centralized-pr') {
            const rule = await this.createOrUpdate(
                organizationAndTeamData,
                payload,
                userInfo,
            );

            return { rule };
        }

        const persistedPending =
            await this.persistMemoryCentralizedPendingStatus(
                organizationAndTeamData,
                payload,
                operation,
                userInfo,
            );

        return {
            rule: persistedPending || payload,
            linkOverride: centralizedPr.prUrl || '',
        };
    }

    private async persistMemoryCentralizedPendingStatus(
        organizationAndTeamData: OrganizationAndTeamData,
        memoryPayload: Partial<IKodyRule>,
        operation: 'create' | 'update',
        userInfo?: UserInfo,
    ): Promise<Partial<IKodyRule> | IKodyRule | null> {
        if (!memoryPayload.title || !memoryPayload.repositoryId) {
            return null;
        }

        const ccp = await this.resolveCentralizedConfigPrService();
        const repositoryFolder = await ccp.resolveRepositoryFolderName(
            organizationAndTeamData,
            memoryPayload.repositoryId,
        );

        const centralizedPath = buildKodyRuleCentralizedFilePath({
            centralizedConfigPrService: ccp,
            repositoryFolder,
            rulesDirectory: 'memories',
            ruleContent: memoryPayload,
        });

        if (operation === 'update' && !memoryPayload.uuid) {
            return null;
        }

        return this.createOrUpdate(
            organizationAndTeamData,
            {
                ...(memoryPayload as CreateKodyRuleDto),
                type: KodyRulesType.MEMORY,
                centralizedConfig: {
                    path: centralizedPath,
                    status:
                        operation === 'create'
                            ? KodyRuleCentralizedStatus.PENDING_ADD
                            : KodyRuleCentralizedStatus.PENDING_EDIT,
                },
            },
            userInfo,
        );
    }

    private async shouldRequireApprovalForGeneratedMemory(
        organizationAndTeamData: OrganizationAndTeamData,
        memory: IKodyRuleMemory,
    ): Promise<boolean> {
        if (
            memory.origin !== KodyRulesOrigin.GENERATED ||
            !organizationAndTeamData?.organizationId ||
            !organizationAndTeamData?.teamId
        ) {
            return false;
        }

        try {
            const mergedConfig =
                await this.codeBaseConfigService.getSimpleConfig(
                    organizationAndTeamData,
                    {
                        repositoryId: memory.repositoryId,
                        directoryId: memory.directoryId,
                    },
                );

            return mergedConfig.llmGeneratedMemoriesRequireApproval === true;
        } catch (error) {
            this.logger.error({
                message:
                    'Error resolving llmGeneratedMemoriesRequireApproval, defaulting to active memories',
                error,
                context: KodyRulesService.name,
                metadata: {
                    organizationAndTeamData,
                    repositoryId: memory.repositoryId,
                    directoryId: memory.directoryId,
                },
            });
            return false;
        }
    }

    private async resolveGeneratedMemoryAction(
        organizationAndTeamData: OrganizationAndTeamData,
        memory: IKodyRuleMemory,
    ): Promise<
        | {
              action: 'create';
              memoryToPersist: IKodyRuleMemory;
          }
        | {
              action: 'skip';
              existingMemory: Partial<IKodyRule>;
          }
        | {
              action: 'update';
              memoryToPersist: IKodyRuleMemory;
              targetMemory: Partial<IKodyRule>;
          }
        | null
    > {
        if (memory.origin !== KodyRulesOrigin.GENERATED || memory.uuid) {
            return null;
        }

        try {
            const entity = await this.findByOrganizationId(
                organizationAndTeamData.organizationId,
            );

            const existingMemories = (entity?.rules || []).filter(
                (rule) =>
                    rule.type === KodyRulesType.MEMORY &&
                    rule.status === KodyRulesStatus.ACTIVE,
            );

            if (!existingMemories.length) {
                return {
                    action: 'create',
                    memoryToPersist: memory,
                };
            }

            const result = await this.evaluateMemoryActionViaLLM(
                organizationAndTeamData,
                memory,
                existingMemories,
            );

            if (!result?.action || result.action === 'create') {
                return { action: 'create', memoryToPersist: memory };
            }

            const matchedMemory =
                existingMemories.find(
                    (m) => m.uuid === result.targetMemoryUuid,
                ) ||
                existingMemories.find((m) =>
                    this.isExactMemoryMatch(m, memory),
                );

            if (result.action === 'skip' && matchedMemory) {
                return { action: 'skip', existingMemory: matchedMemory };
            }

            if (result.action === 'update' && matchedMemory?.uuid) {
                return {
                    action: 'update',
                    memoryToPersist: {
                        ...memory,
                        uuid: matchedMemory.uuid,
                        title: result.updatedTitle?.trim() || memory.title,
                        rule: result.updatedRule?.trim() || memory.rule,
                    },
                    targetMemory: matchedMemory,
                };
            }

            return { action: 'create', memoryToPersist: memory };
        } catch (error) {
            this.logger.error({
                message:
                    'Error resolving generated memory action - defaulting to create',
                error,
                context: KodyRulesService.name,
                metadata: {
                    organizationAndTeamData,
                    memory,
                },
            });

            return {
                action: 'create',
                memoryToPersist: memory,
            };
        }
    }

    private async createPendingRequest(
        orgData: OrganizationAndTeamData,
        memory: IKodyRuleMemory,
        userInfo: UserInfo | undefined,
        requestType: KodyRuleRequestType,
        targetRuleUuid?: string,
    ): Promise<CreateOrUpdateMemoryResult | null> {
        const rule = await this.createOrUpdate(
            orgData,
            {
                ...this.getBaseMemoryPayload(memory),
                uuid: undefined,
                status: KodyRulesStatus.PENDING,
                requestType,
                targetRuleUuid,
            },
            userInfo,
        );

        return rule
            ? {
                  rule,
                  action: 'created',
                  requiresApproval: true,
                  link: this.buildMemoryLink(
                      rule.repositoryId,
                      rule.uuid,
                      orgData.teamId,
                      rule.status,
                  ),
              }
            : null;
    }

    private getBaseMemoryPayload(memory: IKodyRuleMemory) {
        return {
            ...memory,
            path: memory.path || null,
            origin: memory.origin || KodyRulesOrigin.USER,
            severity: KodyRuleSeverity.MEDIUM,
            examples: [],
            inheritance: {
                inheritable: true,
                exclude: [],
                include: [],
            },
        };
    }

    private isExactMemoryMatch(
        existingMemory: Partial<IKodyRule>,
        incomingMemory: IKodyRuleMemory,
    ): boolean {
        return (
            this.normalizeMemoryText(existingMemory.title) ===
                this.normalizeMemoryText(incomingMemory.title) &&
            this.normalizeMemoryText(existingMemory.rule) ===
                this.normalizeMemoryText(incomingMemory.rule)
        );
    }

    private normalizeMemoryText(value?: string): string {
        return (value || '').toLowerCase().trim().replace(/\s+/g, ' ');
    }

    private async evaluateMemoryActionViaLLM(
        organizationAndTeamData: OrganizationAndTeamData,
        memory: IKodyRuleMemory,
        existingMemories: Partial<IKodyRule>[],
    ) {
        const byokConfigValue =
            await this.permissionValidationService.getBYOKConfig(
                organizationAndTeamData,
            );
        const runName = 'kodyMemoryResolution';

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            LLMModelProvider.GROQ_MOONSHOTAI_KIMI_K2_,
            LLMModelProvider.GROQ_GPT_OSS_120B,
            byokConfigValue,
        );

        const incomingMemory = {
            title: memory.title,
            rule: memory.rule,
            repositoryId: memory.repositoryId,
            directoryId: memory.directoryId,
            path: memory.path || undefined,
        };

        const existingForPrompt = existingMemories.map((existingMemory) => ({
            uuid: existingMemory.uuid,
            title: existingMemory.title,
            rule: existingMemory.rule,
            repositoryId: existingMemory.repositoryId,
            directoryId: existingMemory.directoryId,
            path: existingMemory.path,
        }));

        const { result } = await this.observabilityService.runLLMInSpan({
            spanName: `${KodyRulesService.name}::${runName}`,
            runName,
            attrs: {
                organizationId: organizationAndTeamData.organizationId,
                existingMemoriesCount: existingMemories.length,
                type: promptRunner.executeMode,
            },
            byokConfig: byokConfigValue,
            exec: async (callbacks) => {
                return await promptRunner
                    .builder()
                    .setParser(ParserType.ZOD, kodyMemoryResolutionSchema, {
                        provider: LLMModelProvider.GEMINI_2_5_FLASH,
                        fallbackProvider: LLMModelProvider.OPENAI_GPT_4O,
                    })
                    .setLLMJsonMode(true)
                    .setPayload({
                        organizationId: organizationAndTeamData.organizationId,
                        incomingMemory,
                        existingMemories: existingForPrompt,
                    })
                    .addPrompt({
                        role: PromptRole.SYSTEM,
                        prompt: prompt_kodyMemoryResolution_system,
                    })
                    .addPrompt({
                        role: PromptRole.USER,
                        prompt: prompt_kodyMemoryResolution_user,
                    })
                    .addCallbacks(callbacks)
                    .addMetadata({ runName })
                    .setRunName(runName)
                    .execute();
            },
        });

        return result;
    }

    async findMemories(
        organizationAndTeamData: OrganizationAndTeamData,
        filters?: FindMemoriesFilters,
    ): Promise<FindMemoriesResult[]> {
        try {
            const entity = await this.findByOrganizationId(
                organizationAndTeamData.organizationId,
            );

            if (!entity?.rules?.length) {
                return [];
            }

            const safeLimit = Math.min(Math.max(filters?.limit ?? 20, 1), 20);
            const normalizedKeywords = (filters?.keywords || [])
                .map((keyword) => keyword?.trim())
                .filter((keyword): keyword is string => Boolean(keyword));
            const normalizedPathFilter = filters?.path?.trim();

            const inheritedMemories =
                this.kodyRulesValidationService.getMemoryRulesForContext(
                    normalizedPathFilter || null,
                    entity.rules,
                    {
                        repositoryId: filters?.repositoryId,
                        directoryId: filters?.repositoryId
                            ? filters?.directoryId
                            : undefined,
                    },
                );

            const filteredMemories = inheritedMemories
                .filter((rule): rule is IKodyRule => {
                    if (normalizedKeywords.length === 0) {
                        return true;
                    }

                    const haystack = `${rule.title || ''} ${rule.rule || ''}`
                        .trim()
                        .toLowerCase();

                    if (!haystack) {
                        return false;
                    }

                    return normalizedKeywords.some((keyword) =>
                        haystack.includes(keyword.toLowerCase()),
                    );
                })
                .sort((a, b) => {
                    const aTime = a.createdAt
                        ? new Date(a.createdAt).getTime()
                        : 0;
                    const bTime = b.createdAt
                        ? new Date(b.createdAt).getTime()
                        : 0;

                    return bTime - aTime;
                })
                .slice(0, safeLimit)
                .map((memory) => ({
                    uuid: memory.uuid,
                    title: memory.title,
                    rule: memory.rule,
                    repositoryId: memory.repositoryId,
                    directoryId: memory.directoryId || undefined,
                    path: memory.path || undefined,
                    createdAt: memory.createdAt?.toISOString(),
                    link: this.buildMemoryLink(
                        memory.repositoryId,
                        memory.uuid,
                        organizationAndTeamData.teamId,
                        memory.status,
                    ),
                }));

            return filteredMemories;
        } catch (error) {
            this.logger.error({
                message: 'Error in findMemories',
                error,
                context: KodyRulesService.name,
                metadata: {
                    organizationAndTeamData,
                    filters,
                },
            });

            throw error;
        }
    }

    private buildMemoryLink(
        repositoryId: string | null | undefined,
        ruleId: string | undefined,
        teamId?: string,
        status?: KodyRulesStatus,
    ): string {
        return buildKodyRuleAppLink({
            repositoryId,
            ruleId,
            teamId,
            status,
            tab: 'memories',
        });
    }
}
