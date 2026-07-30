import { KodusConfigFile } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IKodyRule,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { DeepPartial } from 'typeorm';

export const CENTRALIZED_CONFIG_SERVICE_TOKEN =
    'CENTRALIZED_CONFIG_SERVICE_TOKEN';

export interface IConfigFileMeta {
    centralizedDirectoryPath?: string;
    repositoryId?: string;
    directoryPath?: string;
    directoryPaths?: string[];
}

export interface IKodyRuleFileMeta {
    centralizedDirectoryPath: string; // Path in centralized repo, e.g., "org-a/.kody-rules/memories"
    repositoryId?: string; // Target repository ID or undefined for global
    directoryPath?: string; // Target directory path (canonical: first folder of the group) or undefined for repo-level
    directoryPaths?: string[]; // All folder paths of the directory group when the rule lives inside one
    ruleType: KodyRulesType; // MEMORY or STANDARD based on subdirectory
    ruleFilePath: string; // Full path in centralized repo, e.g., "org-a/.kody-rules/memories/logging.yml"
    path: string; // Canonical centralized source path for DB tracking, e.g., "org-a/.kody-rules/memories/logging.yml"
}

export interface ICentralizedConfigService {
    /**
     * Validates if centralized config is enabled and properly configured for the team
     */
    validateCentralizedConfig(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository?: { name: string; id: string };
    }): Promise<{
        success: boolean;
        message: string;
    }>;

    /**
     * Gets the centralized config repository configuration
     */
    getCentralizedConfigRepository(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{ name: string; id: string }>;

    /**
     * Discovers all kodus-config.yml files in the centralized config repository
     */
    discoverConfigFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
    }): Promise<IConfigFileMeta[]>;

    /**
     * Fetches a specific config file from the repository
     */
    fetchConfigFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        dir?: string;
    }): Promise<KodusConfigFile | null>;

    /**
     * Synchronizes config files by updating parameters based on discovered files
     */
    synchronizeConfigs(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        configFiles: IConfigFileMeta[];
        actor: {
            organizationId: string;
            source: string;
            userEmail: string;
            userId: string;
        };
    }): Promise<{
        success: boolean;
        message: string;
    }>;

    /**
     * Removes stale configs that are no longer present in the repository
     */
    removeStaleConfigs(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        configFiles: IConfigFileMeta[];
        actor: {
            organizationId: string;
            source: string;
            userEmail: string;
            userId: string;
        };
    }): Promise<{
        success: boolean;
        message: string;
    }>;

    /**
     * Discovers all .kody-rules YAML files in the centralized config repository
     */
    discoverKodyRulesFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
    }): Promise<IKodyRuleFileMeta[]>;

    /**
     * Fetches and parses a Kody rule file from the centralized repository
     */
    fetchKodyRuleFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        filePath: string;
    }): Promise<DeepPartial<IKodyRule> | null>;

    /**
     * Synchronizes Kody rules from centralized repository to target scopes
     */
    synchronizeKodyRules(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        ruleFiles: IKodyRuleFileMeta[];
        actor: {
            organizationId: string;
            source: string;
            userEmail: string;
            userId: string;
        };
    }): Promise<{
        success: boolean;
        message: string;
        syncedRuleCount?: number;
        failureDetails?: Array<{ file: string; error: string }>;
    }>;

    /**
     * Removes stale Kody rules that are no longer present in centralized repository
     */
    removeStaleKodyRules(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        ruleFiles: IKodyRuleFileMeta[];
        actor: {
            organizationId: string;
            source: string;
            userEmail: string;
            userId: string;
        };
    }): Promise<{
        success: boolean;
        message: string;
        removedRuleCount?: number;
    }>;
}
