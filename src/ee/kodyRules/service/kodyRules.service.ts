import {
    IKodyRulesRepository,
    KODY_RULES_REPOSITORY_TOKEN,
} from '@/core/domain/kodyRules/contracts/kodyRules.repository.contract';
import { IKodyRulesService } from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import { KodyRulesEntity } from '@/core/domain/kodyRules/entities/kodyRules.entity';
import {
    IKodyRule,
    IKodyRules,
    IKodyRuleExternalReference,
    IKodyRuleReferenceSyncError,
    KodyRuleProcessingStatus,
    KodyRulesOrigin,
    KodyRulesScope,
    KodyRulesStatus,
} from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { CreateKodyRuleDto } from '@/core/infrastructure/http/dtos/create-kody-rule.dto';
import { v4 } from 'uuid';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import * as libraryKodyRules from './data/library-kody-rules.json';
import * as bucketsData from './data/buckets.json';
import {
    KodyRuleFilters,
    LibraryKodyRule,
    BucketInfo,
} from '@/config/types/kodyRules.type';
import { ProgrammingLanguage } from '@/shared/domain/enums/programming-language.enum';
import {
    CODE_REVIEW_SETTINGS_LOG_SERVICE_TOKEN,
    ICodeReviewSettingsLogService,
} from '@/ee/codeReviewSettingsLog/domain/codeReviewSettingsLog/contracts/codeReviewSettingsLog.service.contract';
import {
    ActionType,
    UserInfo,
} from '@/config/types/general/codeReviewSettingsLog.type';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    IRuleLikeService,
    RULE_LIKE_SERVICE_TOKEN,
} from '@/core/domain/kodyRules/contracts/ruleLike.service.contract';
import { KodyRulesValidationService } from './kody-rules-validation.service';
import { MCPManagerService } from '@/core/infrastructure/adapters/mcp/services/mcp-manager.service';
import {
    IPullRequestsRepository,
    PULL_REQUESTS_REPOSITORY_TOKEN,
} from '@/core/domain/pullRequests/contracts/pullRequests.repository';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { ObservabilityService } from '@/core/infrastructure/adapters/services/logger/observability.service';
import { BYOKPromptRunnerService } from '@/shared/infrastructure/services/tokenTracking/byokPromptRunner.service';
import {
    LLMModelProvider,
    ParserType,
    PromptRole,
} from '@kodus/kodus-common/llm';
import { kodyRulesRecommendationSchema } from '@/shared/utils/langchainCommon/prompts/kodyRulesRecommendation';
import { PermissionValidationService } from '@/ee/shared/services/permissionValidation.service';

@Injectable()
export class KodyRulesService implements IKodyRulesService {
    constructor(
        @Inject(KODY_RULES_REPOSITORY_TOKEN)
        private readonly kodyRulesRepository: IKodyRulesRepository,

        @Inject(CODE_REVIEW_SETTINGS_LOG_SERVICE_TOKEN)
        private readonly codeReviewSettingsLogService: ICodeReviewSettingsLogService,

        @Inject(RULE_LIKE_SERVICE_TOKEN)
        private readonly ruleLikeService: IRuleLikeService,

        @Inject(PULL_REQUESTS_REPOSITORY_TOKEN)
        private readonly pullRequestsRepository: IPullRequestsRepository,

        private readonly logger: PinoLoggerService,

        private readonly kodyRulesValidationService: KodyRulesValidationService,

        private readonly mcpManagerService: MCPManagerService,

        private readonly promptRunnerService: PromptRunnerService,

        private readonly observabilityService: ObservabilityService,

        private readonly permissionValidationService: PermissionValidationService,
    ) {}

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
            const existing = await this.findByOrganizationId(
                organizationAndTeamData.organizationId,
            );

            const totalActiveRules =
                existing?.rules?.filter(
                    (rule) => rule.status === KodyRulesStatus.ACTIVE,
                )?.length || 0;

            return {
                total: totalActiveRules,
            };
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
     * Busca rules específicas por organização, repositório e diretório
     * Versão simplificada que filtra in-memory
     */
    async findRulesByDirectory(
        organizationId: string,
        repositoryId: string,
        directoryId: string,
    ): Promise<Partial<IKodyRule>[]> {
        const entity = await this.findByOrganizationId(organizationId);

        if (!entity?.toObject()?.rules) {
            return [];
        }

        return entity
            .toObject()
            .rules.filter(
                (rule) =>
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

        // If no rules exist for the organization
        if (!existing) {
            if (kodyRule.uuid) {
                throw new NotFoundException('Rule not found');
            }

            await this.ensureFreePlanLimit(organizationAndTeamData, 1);

            const newRule: IKodyRule = {
                uuid: v4(),
                title: kodyRule?.title,
                rule: kodyRule?.rule,
                path: kodyRule?.path,
                severity: kodyRule?.severity?.toLowerCase(),
                status: kodyRule?.status ?? KodyRulesStatus.ACTIVE,
                sourcePath: kodyRule?.sourcePath,
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

            try {
                this.codeReviewSettingsLogService.registerKodyRulesLog({
                    organizationAndTeamData,
                    userInfo,
                    actionType: ActionType.CLONE,
                    repository: { id: newRule.repositoryId },
                    oldRule: undefined,
                    newRule: newRule,
                    ruleTitle: newRule.title,
                });
            } catch (error) {
                this.logger.error({
                    message: 'Error in registerKodyRulesLog',
                    error: error,
                    context: KodyRulesService.name,
                    metadata: {
                        organizationAndTeamData: organizationAndTeamData,
                        repositoryId: newRule.repositoryId,
                    },
                });
            }

            return newKodyRules.rules[0];
        }

        // If there is no UUID, it is a new rule
        if (!kodyRule.uuid) {
            await this.ensureFreePlanLimit(
                organizationAndTeamData,
                (existing.rules?.length ?? 0) + 1,
            );

            const newRule: IKodyRule = {
                uuid: v4(),
                title: kodyRule.title,
                rule: kodyRule.rule,
                path: kodyRule.path,
                sourcePath: kodyRule.sourcePath,
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
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            const updatedKodyRules = await this.addRule(existing.uuid, newRule);

            if (!updatedKodyRules) {
                throw new Error('Could not add new rule');
            }

            try {
                this.codeReviewSettingsLogService.registerKodyRulesLog({
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
            } catch (error) {
                this.logger.error({
                    message: 'Error in registerKodyRulesLog',
                    error: error,
                    context: KodyRulesService.name,
                    metadata: {
                        organizationAndTeamData: organizationAndTeamData,
                        repositoryId: newRule.repositoryId,
                    },
                });
            }

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

        const updatedRule = {
            ...existingRule,
            ...kodyRule,
            updatedAt: new Date(),
        };

        const updatedKodyRules = await this.updateRule(
            existing.uuid,
            kodyRule.uuid,
            updatedRule,
        );

        try {
            this.codeReviewSettingsLogService.registerKodyRulesLog({
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
        } catch (error) {
            this.logger.error({
                message: 'Error in registerKodyRulesLog',
                error: error,
                context: KodyRulesService.name,
                metadata: {
                    organizationAndTeamData: organizationAndTeamData,
                    repositoryId: updatedRule.repositoryId,
                    directoryId: updatedRule?.directoryId,
                },
            });
        }

        if (!updatedKodyRules) {
            throw new Error('Could not update rule');
        }

        return updatedKodyRules.rules.find(
            (rule) => rule.uuid === kodyRule.uuid,
        );
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

        const updatedRule = {
            ...existingRule,
            ...kodyRule,
            updatedAt: new Date(),
        };

        const updatedKodyRules = await this.updateRule(
            existing.uuid,
            kodyRule.uuid,
            updatedRule,
        );

        try {
            this.codeReviewSettingsLogService.registerKodyRulesLog({
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
        } catch (error) {
            this.logger.error({
                message: 'Error in registerKodyRulesLog',
                error: error,
                context: KodyRulesService.name,
                metadata: {
                    organizationAndTeamData,
                    repositoryId: updatedRule.repositoryId,
                    directoryId: updatedRule.directoryId,
                },
            });
        }

        if (!updatedKodyRules) {
            throw new Error('Could not update rule');
        }

        return updatedKodyRules.rules.find(
            (rule) => rule.uuid === kodyRule.uuid,
        );
    }

    async deleteRule(uuid: string, ruleId: string): Promise<Boolean> {
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

            try {
                this.codeReviewSettingsLogService.registerKodyRulesLog({
                    organizationAndTeamData,
                    userInfo,
                    actionType: ActionType.DELETE,
                    repository: { id: deletedRule.repositoryId },
                    oldRule: deletedRule,
                    newRule: undefined,
                    ruleTitle: deletedRule.title,
                });
            } catch (error) {
                this.logger.error({
                    message: 'Error saving code review settings log',
                    error: error,
                    context: KodyRulesService.name,
                    metadata: {
                        ...organizationAndTeamData,
                        ruleId,
                        userInfo,
                    },
                });
            }

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

            const bucketsWithCount = bucketsData.map((bucket: BucketInfo) => ({
                slug: bucket.slug,
                title: bucket.title,
                description: bucket.description,
                rulesCount: bucketRuleCounts.get(bucket.slug) || 0,
            }));

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
${JSON.stringify(allSuggestions, null, 2)}

## Available Rules Library (filtered by language):
${JSON.stringify(filteredLibrary, null, 2)}

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
}
