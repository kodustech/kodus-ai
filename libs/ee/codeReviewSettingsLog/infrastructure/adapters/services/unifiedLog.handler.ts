import {
    CONTEXT_RESOLUTION_SERVICE_TOKEN,
    IContextResolutionService,
} from '@libs/core/context-resolution/domain/contracts/context-resolution.service.contract';
import { RepositoryNotIntegratedError } from '@libs/core/context-resolution/domain/errors/repository-not-integrated.error';
import {
    ActionType,
    ConfigLevel,
    UserInfo,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    CODE_REVIEW_SETTINGS_LOG_REPOSITORY_TOKEN,
    ICodeReviewSettingsLogRepository,
} from '@libs/ee/codeReviewSettingsLog/domain/contracts/codeReviewSettingsLog.repository.contract';
import { createLogger } from '@libs/core/log/logger';
import { Injectable, Inject } from '@nestjs/common';

export interface ChangedDataToExport {
    actionDescription: string;
    previousValue: any;
    currentValue: any;
    description: string;
}

export interface BaseLogParams {
    organizationAndTeamData: OrganizationAndTeamData;
    userInfo: UserInfo;
    actionType: ActionType;
    configLevel?: ConfigLevel;
    repository?: { id: string; name?: string };
    directory?: { id?: string; path?: string };
}

export interface UnifiedLogParams extends BaseLogParams {
    entityType: string;
    entityName?: string;
    oldData?: any;
    newData?: any;
    customChangedData?: ChangedDataToExport[];
}

@Injectable()
export class UnifiedLogHandler {
    private readonly logger = createLogger(UnifiedLogHandler.name);
    private readonly repositoryNames = new Map<string, CachedRepositoryName>();

    constructor(
        @Inject(CODE_REVIEW_SETTINGS_LOG_REPOSITORY_TOKEN)
        private readonly codeReviewSettingsLogRepository: ICodeReviewSettingsLogRepository,
        @Inject(CONTEXT_RESOLUTION_SERVICE_TOKEN)
        private readonly contextResolutionService: IContextResolutionService,
    ) {}

    public async logAction(params: UnifiedLogParams): Promise<void> {
        const {
            organizationAndTeamData,
            userInfo,
            actionType,
            configLevel,
            repository,
            directory,
            entityType,
            entityName,
            oldData,
            newData,
            customChangedData,
        } = params;

        const changedData =
            customChangedData ||
            this.generateChangedData({
                actionType,
                entityType,
                entityName,
                oldData,
                newData,
                userInfo,
            });

        await this.fillLocationNames({
            organizationId: organizationAndTeamData.organizationId,
            configLevel,
            repository,
            directory,
        });

        await this.codeReviewSettingsLogRepository.create({
            organizationId: organizationAndTeamData.organizationId,
            teamId: organizationAndTeamData.teamId,
            action: actionType,
            userInfo: {
                userId: userInfo.userId,
                userEmail: userInfo.userEmail,
            },
            configLevel,
            repository,
            directory,
            changedData,
        });
    }

    public async saveLogEntry(
        params: BaseLogParams & { changedData: ChangedDataToExport[] },
    ): Promise<void> {
        const {
            organizationAndTeamData,
            userInfo,
            actionType,
            configLevel,
            repository,
            directory,
            changedData,
        } = params;

        await this.fillLocationNames({
            organizationId: organizationAndTeamData.organizationId,
            configLevel,
            repository,
            directory,
        });

        await this.codeReviewSettingsLogRepository.create({
            organizationId: organizationAndTeamData.organizationId,
            teamId: organizationAndTeamData.teamId,
            action: actionType,
            userInfo: {
                userId: userInfo.userId,
                userEmail: userInfo.userEmail,
            },
            configLevel,
            repository,
            directory,
            changedData,
        });
    }

    /**
     * Fills the repository name or directory path the caller left out. When
     * the lookup fails the entry is still written, with "Unknown".
     */
    private async fillLocationNames(params: {
        organizationId: string;
        configLevel?: ConfigLevel;
        repository?: { id: string; name?: string };
        directory?: { id?: string; path?: string };
    }): Promise<void> {
        const { organizationId, configLevel, repository, directory } = params;

        try {
            if (configLevel === ConfigLevel.REPOSITORY && !repository?.name) {
                repository.name = await this.getRepositoryAdditionalInfo(
                    repository?.id,
                    organizationId,
                );
            }
        } catch (error) {
            this.logLookupFailure(
                'Error getting repository additional info',
                error,
                {
                    organizationId,
                    repositoryId: repository?.id,
                },
            );
            if (repository) {
                repository.name = 'Unknown';
            }
        }

        try {
            if (configLevel === ConfigLevel.DIRECTORY && !directory?.path) {
                directory.path = await this.getDirectoryAdditionalInfo(
                    directory?.id,
                    repository?.id,
                    organizationId,
                );
            }
        } catch (error) {
            this.logLookupFailure(
                'Error getting directory additional info',
                error,
                {
                    organizationId,
                    repositoryId: repository?.id,
                    directoryId: directory?.id,
                },
            );
            if (directory) {
                directory.path = 'Unknown';
            }
        }
    }

    private logLookupFailure(
        message: string,
        error: Error,
        metadata: {
            organizationId: string;
            repositoryId?: string;
            directoryId?: string;
        },
    ): void {
        // A repository removed from the integration still gets entries:
        // removing its synced Kody Rules writes one per rule (issue #2581).
        // Nothing is wrong there, and "Unknown" is all that can be said.
        if (error instanceof RepositoryNotIntegratedError) {
            return;
        }
        this.logger.error({
            message,
            context: UnifiedLogHandler.name,
            error,
            metadata,
        });
    }

    private generateChangedData(params: {
        actionType: ActionType;
        entityType: string;
        entityName?: string;
        oldData?: any;
        newData?: any;
        userInfo: UserInfo;
    }): ChangedDataToExport[] {
        const {
            actionType,
            entityType,
            entityName,
            oldData,
            newData,
            userInfo,
        } = params;

        const actionDescription = this.generateActionDescription(
            entityType,
            actionType,
        );
        const description = this.generateDescription(
            actionType,
            entityType,
            entityName,
            userInfo.userEmail,
        );

        return [
            {
                actionDescription,
                previousValue: oldData || null,
                currentValue: newData || null,
                description,
            },
        ];
    }

    private generateActionDescription(
        entityType: string,
        actionType: ActionType,
    ): string {
        const entityDisplayNames = {
            kodyRule: 'Kody Rule',
            config: 'Configuration',
            repository: 'Repository',
            integration: 'Integration',
            user: 'User',
        };

        const actionDisplayNames = {
            [ActionType.CREATE]: 'Created',
            [ActionType.EDIT]: 'Edited',
            [ActionType.DELETE]: 'Deleted',
            [ActionType.ADD]: 'Added',
        };

        const entityDisplay =
            entityDisplayNames[entityType] ||
            this.capitalizeFirstLetter(entityType);
        const actionDisplay = actionDisplayNames[actionType] || actionType;

        return `${entityDisplay} ${actionDisplay}`;
    }

    private generateDescription(
        actionType: ActionType,
        entityType: string,
        entityName: string | undefined,
        userEmail: string,
    ): string {
        const actionVerbs = {
            [ActionType.CREATE]: 'created',
            [ActionType.EDIT]: 'edited',
            [ActionType.DELETE]: 'deleted',
            [ActionType.ADD]: 'added',
        };

        const verb = actionVerbs[actionType] || actionType.toLowerCase();
        const entityDisplay = entityName ? `"${entityName}"` : entityType;

        return `User ${userEmail} ${verb} ${entityDisplay}`;
    }

    private capitalizeFirstLetter(string: string): string {
        return string.charAt(0).toUpperCase() + string.slice(1);
    }

    // Utility methods for value comparison and formatting
    public static hasChanged(oldValue: any, newValue: any): boolean {
        if (oldValue === newValue) return false;

        if (Array.isArray(oldValue) && Array.isArray(newValue)) {
            if (oldValue.length !== newValue.length) return true;
            return oldValue.some(
                (item, index) => !this.isEqual(item, newValue[index]),
            );
        }

        if (
            oldValue &&
            newValue &&
            typeof oldValue === 'object' &&
            typeof newValue === 'object'
        ) {
            const keysOld = Object.keys(oldValue);
            const keysNew = Object.keys(newValue);

            if (keysOld.length !== keysNew.length) return true;
            return keysOld.some(
                (key) => !this.isEqual(oldValue[key], newValue[key]),
            );
        }

        return true;
    }

    private static isEqual(a: any, b: any): boolean {
        if (a === b) return true;

        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return false;
            return a.every((item, index) => this.isEqual(item, b[index]));
        }

        if (a && b && typeof a === 'object' && typeof b === 'object') {
            const keysA = Object.keys(a);
            const keysB = Object.keys(b);

            if (keysA.length !== keysB.length) return false;
            return keysA.every((key) => this.isEqual(a[key], b[key]));
        }

        return false;
    }

    public static formatValue(value: any): string {
        if (value === null || value === undefined) {
            return 'none';
        }

        if (typeof value === 'boolean') {
            return value ? 'enabled' : 'disabled';
        }

        if (Array.isArray(value)) {
            return value.join(', ') || 'none';
        }

        if (typeof value === 'object') {
            return JSON.stringify(value);
        }

        return String(value);
    }

    private async getDirectoryAdditionalInfo(
        directoryId: string,
        repositoryId: string,
        organizationId: string,
        directoryPathParam?: string,
    ): Promise<string> {
        if (!directoryId || !repositoryId || !organizationId) {
            return '';
        }

        const directoryPath = !directoryPathParam
            ? await this.getDirectoryPath(
                  directoryId,
                  repositoryId,
                  organizationId,
              )
            : directoryPathParam;

        return directoryPath;
    }

    private async getRepositoryAdditionalInfo(
        repositoryId: string,
        organizationId: string,
        repositoryNameParam?: string,
    ): Promise<string> {
        if (!repositoryId || !organizationId) {
            return '';
        }

        const repositoryName = !repositoryNameParam
            ? await this.getRepositoryName(repositoryId, organizationId)
            : repositoryNameParam;

        return repositoryName;
    }

    private async getDirectoryPath(
        directoryId: string,
        repositoryId: string,
        organizationId: string,
    ): Promise<string> {
        const directoryPath =
            await this.contextResolutionService.getDirectoryPathByOrganizationAndRepository(
                organizationId,
                repositoryId,
                directoryId,
            );
        return directoryPath;
    }

    /**
     * Removing the synced Kody Rules of a repository writes one entry per
     * rule, 26 in a row in prod (issue #2581), and each one asked for the
     * same name. The answer is kept briefly per repository, including "not
     * in the integration"; any other failure is not kept, so the next entry
     * asks again.
     */
    private async getRepositoryName(
        repositoryId: string,
        organizationId: string,
    ): Promise<string> {
        const key = `${organizationId}:${repositoryId}`;
        const now = Date.now();
        const cached = this.repositoryNames.get(key);
        if (cached && cached.expiresAt > now) {
            if (cached.error) {
                throw cached.error;
            }
            return cached.name;
        }

        try {
            const name =
                await this.contextResolutionService.getRepositoryNameByOrganizationAndRepository(
                    organizationId,
                    repositoryId,
                );
            this.remember(key, {
                name,
                expiresAt: now + REPOSITORY_NAME_TTL_MS,
            });
            return name;
        } catch (error) {
            if (error instanceof RepositoryNotIntegratedError) {
                this.remember(key, {
                    error,
                    expiresAt: now + REPOSITORY_NAME_TTL_MS,
                });
            }
            throw error;
        }
    }

    private remember(key: string, entry: CachedRepositoryName): void {
        if (this.repositoryNames.size >= REPOSITORY_NAME_CACHE_MAX) {
            this.repositoryNames.clear();
        }
        this.repositoryNames.set(key, entry);
    }
}

// Long enough for one burst of entries, short enough that a rename shows up.
const REPOSITORY_NAME_TTL_MS = 60_000;
const REPOSITORY_NAME_CACHE_MAX = 1_000;

type CachedRepositoryName =
    | { name: string; error?: undefined; expiresAt: number }
    | { name?: undefined; error: Error; expiresAt: number };
