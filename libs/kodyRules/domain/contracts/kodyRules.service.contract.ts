import { UserInfo } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import {
    BucketInfo,
    KodyRuleFilters,
    LibraryKodyRule,
} from '@libs/core/infrastructure/config/types/general/kodyRules.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CreateKodyRuleDto } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import { KodyRulesEntity } from '../entities/kodyRules.entity';
import {
    FindMemoriesFilters,
    FindMemoriesResult,
    IKodyRule,
    IKodyRuleDetector,
    IKodyRuleMemory,
    KodyRulesStatus,
} from '../interfaces/kodyRules.interface';
import { IKodyRulesRepository } from './kodyRules.repository.contract';

export const KODY_RULES_SERVICE_TOKEN = 'KODY_RULES_SERVICE_TOKEN';

export type MemoryCreationAction = 'created' | 'updated' | 'skipped';

export interface CreateOrUpdateMemoryResult {
    rule: Partial<IKodyRule> | IKodyRule;
    action: MemoryCreationAction;
    requiresApproval: boolean;
    link: string;
}

export interface IKodyRulesService extends IKodyRulesRepository {
    createOrUpdate(
        organizationAndTeamData: OrganizationAndTeamData,
        kodyRule: CreateKodyRuleDto,
        userInfo?: UserInfo,
    ): Promise<Partial<IKodyRule> | IKodyRule | null>;

    getLibraryKodyRules(
        filters?: KodyRuleFilters,
        userId?: string,
    ): Promise<LibraryKodyRule[]>;
    getLibraryKodyRulesWithFeedback(
        filters?: KodyRuleFilters,
        userId?: string,
    ): Promise<LibraryKodyRule[]>;

    getLibraryKodyRulesBuckets(): Promise<BucketInfo[]>;

    findRulesByDirectory(
        organizationId: string,
        repositoryId: string,
        directoryId: string,
    ): Promise<Partial<IKodyRule>[]>;
    updateRulesStatusByFilter(
        organizationId: string,
        repositoryId: string,
        directoryId?: string,
        newStatus?: KodyRulesStatus,
    ): Promise<KodyRulesEntity | null>;

    deleteRuleWithLogging(
        organizationAndTeamData: OrganizationAndTeamData,
        ruleId: string,
        userInfo: UserInfo,
    ): Promise<boolean>;

    updateRuleWithLogging(
        organizationAndTeamData: OrganizationAndTeamData,
        kodyRule: CreateKodyRuleDto,
        userInfo?: UserInfo,
    ): Promise<Partial<IKodyRule> | IKodyRule | null>;

    updateRuleReferences(
        organizationId: string,
        ruleId: string,
        references: {
            contextReferenceId?: string;
            // Todos os outros campos de referência foram movidos para Context OS
        },
    ): Promise<IKodyRule | null>;

    /**
     * Persist the T0 compiled detector onto an embedded rule (#1449). Passing
     * `null` clears it (rule reverts to semantic). Mirrors updateRuleReferences.
     */
    updateRuleDetector(
        organizationId: string,
        ruleId: string,
        detector: IKodyRuleDetector | null,
    ): Promise<IKodyRule | null>;

    getRulesLimitStatus(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{
        total: number;
    }>;

    countRulesByRepository(
        organizationId: string,
    ): Promise<
        Array<{
            repositoryId: string;
            directoryId: string | null;
            count: number;
        }>
    >;

    getRecommendedRulesBySuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
        repoLanguage?: string,
    ): Promise<LibraryKodyRule[]>;

    createOrUpdateMemory(
        organizationAndTeamData: OrganizationAndTeamData,
        memory: IKodyRuleMemory,
        userInfo?: UserInfo,
    ): Promise<CreateOrUpdateMemoryResult | null>;

    findMemories(
        organizationAndTeamData: OrganizationAndTeamData,
        filters?: FindMemoriesFilters,
    ): Promise<FindMemoriesResult[]>;
}
