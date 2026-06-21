import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '@kodus/flow';
import { promises as fsPromises } from 'fs';
import * as yaml from 'js-yaml';

import { GenerateKodusConfigFileUseCase } from '@libs/code-review/application/use-cases/configuration/generate-kodus-config-file.use-case';
import { GetCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/get-code-review-parameter.use-case';
import { CentralizedConfigPrService } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { buildGroupFolderName } from '@libs/centralized-config/utils/path-encoder';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/find-rules-in-organization-by-filter.use-case';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import {
    IPullRequestMessagesService,
    PULL_REQUEST_MESSAGES_SERVICE_TOKEN,
} from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import { deepDifference, deepMerge } from '@libs/common/utils/deep';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';

import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import { KodusConfigFile } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import {
    IKodyRule,
    KodyRuleCentralizedStatus,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import * as path from 'path';

type FileEntry = { path: string; content: string };
type CustomMessagesConfig = NonNullable<KodusConfigFile['customMessages']>;

@Injectable()
export class CentralizedConfigDownloadUseCase {
    private readonly logger = createLogger(
        CentralizedConfigDownloadUseCase.name,
    );

    constructor(
        private readonly getCodeReviewParameterUseCase: GetCodeReviewParameterUseCase,
        private readonly generateKodusConfigFileUseCase: GenerateKodusConfigFileUseCase,
        private readonly findRulesInOrganizationByRuleFilterKodyRulesUseCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
        private readonly createOrUpdateKodyRulesUseCase: CreateOrUpdateKodyRulesUseCase,
        @Inject(PULL_REQUEST_MESSAGES_SERVICE_TOKEN)
        private readonly pullRequestMessagesService: IPullRequestMessagesService,
        private readonly centralizedConfigPrService: CentralizedConfigPrService,
    ) {}

    public async execute(
        user: Partial<IUser>,
        teamId: string,
        options: {
            skipAuthorization?: boolean;
            organizationId?: string;
            markRulesAsPendingWithSourcePath?: boolean;
        } = {},
    ): Promise<FileEntry[]> {
        try {
            const codeReview = await this.getCodeReviewParameterUseCase.execute(
                user,
                teamId,
                options,
            );

            const [configEntries, rulesEntries] = await Promise.all([
                this.getConfigEntries(user, teamId, codeReview, options),
                this.getRulesEntries(user, teamId, codeReview, options),
            ]);

            return [...configEntries, ...rulesEntries];
        } catch (error) {
            this.logger.error({
                message: 'Failed to execute centralized config download',
                context: CentralizedConfigDownloadUseCase.name,
                metadata: {
                    teamId,
                    errorMessage: this.getErrorMessage(error),
                },
            });
            throw error;
        }
    }

    private async getConfigEntries(
        user: Partial<IUser>,
        teamId: string,
        codeReview: Awaited<
            ReturnType<GetCodeReviewParameterUseCase['execute']>
        >,
        options: { skipAuthorization?: boolean; organizationId?: string } = {},
    ): Promise<FileEntry[]> {
        const entries: FileEntry[] = [];
        const organizationId =
            user?.organization?.uuid || options.organizationId;

        const customMessagesByScope = await this.getCustomMessagesDiffByScope(
            organizationId,
            teamId,
            codeReview,
        );

        const [defaultConfig, globalConfig] = await Promise.all([
            this.getDefaultConfigEntry(teamId),
            this.getGlobalConfigEntry(
                teamId,
                options,
                customMessagesByScope.get(
                    this.getCustomMessagesScopeKeyGlobal(),
                ),
            ),
        ]);

        if (defaultConfig) entries.push(defaultConfig);
        if (globalConfig) entries.push(globalConfig);

        const repositories = codeReview?.configValue?.repositories ?? [];

        const repoPromises = repositories
            .filter((repo) => repo.isSelected)
            .map(async (repo) => {
                const repoEntries: FileEntry[] = [];
                const repoFolderName = repo.name || repo.id;

                // Repo Level Config
                try {
                    const res =
                        await this.generateKodusConfigFileUseCase.execute(
                            teamId,
                            repo.id,
                            undefined,
                            { skipAuthorization: options.skipAuthorization },
                        );

                    const repoEntry = this.createConfigEntryWithCustomMessages(
                        `${repoFolderName}/kodus-config.yml`,
                        res.yamlString,
                        customMessagesByScope.get(
                            this.getCustomMessagesScopeKeyRepository(
                                String(repo.id),
                            ),
                        ),
                    );

                    if (repoEntry) {
                        repoEntries.push(repoEntry);
                    }
                } catch (error) {
                    this.logger.error({
                        message: 'Failed to generate repo Kodus config file',
                        context: CentralizedConfigDownloadUseCase.name,
                        metadata: {
                            teamId,
                            repoId: repo.id,
                            errorMessage: this.getErrorMessage(error),
                        },
                    });
                }

                // Directory Level Configs (Concurrent)
                const directories = repo.directories ?? [];
                const dirPromises = directories
                    .filter((dir) => dir.isSelected)
                    .map(async (dir) => {
                        try {
                            const res =
                                await this.generateKodusConfigFileUseCase.execute(
                                    teamId,
                                    repo.id,
                                    dir.id,
                                    {
                                        skipAuthorization:
                                            options.skipAuthorization,
                                    },
                                );

                            const hasFolders =
                                Array.isArray(dir.folders) &&
                                dir.folders.length > 0;

                            if (!hasFolders) {
                                return null;
                            }

                            let groupFolderName: string;
                            try {
                                groupFolderName = buildGroupFolderName(
                                    dir.folders.map((f) => f.path),
                                );
                            } catch {
                                return null;
                            }

                            const groupBasePath = `${repoFolderName}/${groupFolderName}`;
                            const configEntryName = `${groupBasePath}/kodus-config.yml`;

                            const customMessages = customMessagesByScope.get(
                                this.getCustomMessagesScopeKeyDirectory(
                                    String(repo.id),
                                    String(dir.id),
                                ),
                            );

                            const configEntry =
                                this.createConfigEntryWithCustomMessages(
                                    configEntryName,
                                    res.yamlString,
                                    customMessages,
                                );

                            return configEntry ? [configEntry] : null;
                        } catch (error) {
                            this.logger.error({
                                message:
                                    'Failed to generate directory Kodus config file',
                                context: CentralizedConfigDownloadUseCase.name,
                                metadata: {
                                    teamId,
                                    repoId: repo.id,
                                    dirId: dir.id,
                                    errorMessage: this.getErrorMessage(error),
                                },
                            });
                        }
                        return null;
                    });

                const dirResults = await Promise.all(dirPromises);
                const flattenedDirResults = dirResults
                    .filter(Boolean)
                    .flat()
                    .filter(Boolean) as FileEntry[];
                repoEntries.push(...flattenedDirResults);

                return repoEntries;
            });

        const nestedRepoEntries = await Promise.all(repoPromises);
        entries.push(...nestedRepoEntries.flat());

        return entries;
    }

    private async getDefaultConfigEntry(
        teamId: string,
    ): Promise<FileEntry | null> {
        try {
            const filePath = path.join(
                process.cwd(),
                'default-kodus-config.yml',
            );
            const fileContent = await fsPromises.readFile(filePath, 'utf8');
            const header = `# This file is a copy of the default Kodus configuration. It is provided for reference and can be used as a starting point for your own configuration.\n# Any changes to this file will not affect the actual configuration used by Kodus.\n# Your own configuration should be defined in the global or repository-specific config files.\n# They behave as a diff to this default config, or higher level config that exists, so you only need to include the properties you want to override.\n\n`;

            return {
                path: 'default-kodus-config.yml',
                content: header + fileContent,
            };
        } catch (error) {
            this.logger.error({
                message: 'Failed to load default Kodus config file',
                context: CentralizedConfigDownloadUseCase.name,
                metadata: {
                    teamId,
                    errorMessage: this.getErrorMessage(error),
                },
            });
            return null;
        }
    }

    private async getGlobalConfigEntry(
        teamId: string,
        options: { skipAuthorization?: boolean },
        customMessages?: NonNullable<KodusConfigFile['customMessages']>,
    ): Promise<FileEntry | null> {
        try {
            const res = await this.generateKodusConfigFileUseCase.execute(
                teamId,
                'global',
                undefined,
                { skipAuthorization: options.skipAuthorization },
            );

            return this.createConfigEntryWithCustomMessages(
                'kodus-config.yml',
                res.yamlString,
                customMessages,
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to generate global Kodus config file',
                context: CentralizedConfigDownloadUseCase.name,
                metadata: {
                    teamId,
                    errorMessage: this.getErrorMessage(error),
                },
            });
        }
        return null;
    }

    private async getRulesEntries(
        user: Partial<IUser>,
        teamId: string,
        codeReview: Awaited<
            ReturnType<GetCodeReviewParameterUseCase['execute']>
        >,
        options: {
            skipAuthorization?: boolean;
            organizationId?: string;
            markRulesAsPendingWithSourcePath?: boolean;
        } = {},
    ): Promise<FileEntry[]> {
        const entries: FileEntry[] = [];
        const organizationId =
            user?.organization?.uuid || options.organizationId;

        if (!organizationId) {
            this.logger.warn({
                message: 'Organization ID not found for user',
                context: CentralizedConfigDownloadUseCase.name,
                metadata: { teamId, userId: user?.uuid },
            });
            return entries;
        }

        const repositoryMapping = new Map<
            string,
            {
                repoFolderName: string;
                directoriesById: Map<string, string>;
                groupFolderNamesById: Map<string, string>;
            }
        >();

        for (const repo of codeReview?.configValue?.repositories ?? []) {
            const directoriesById = new Map<string, string>();
            const groupFolderNamesById = new Map<string, string>();

            for (const dir of repo.directories ?? []) {
                directoriesById.set(
                    String(dir.id),
                    this.normalizeDirectoryPath(
                        dir.folders?.[0]?.path ?? (dir as any).path,
                    ),
                );

                if (dir.folders && dir.folders.length > 0) {
                    try {
                        groupFolderNamesById.set(
                            String(dir.id),
                            buildGroupFolderName(
                                dir.folders.map((f) => f.path),
                            ),
                        );
                    } catch {
                        // Skip directories with invalid path sets — they cannot
                        // be reached on disk and shouldn't host rule entries.
                    }
                }
            }

            repositoryMapping.set(String(repo.id), {
                repoFolderName: repo.name || repo.id,
                directoriesById,
                groupFolderNamesById,
            });
        }

        const fetchedRules =
            (await this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
                organizationId,
                options.markRulesAsPendingWithSourcePath
                    ? {}
                    : { status: KodyRulesStatus.ACTIVE },
            )) as IKodyRule[];

        const rules = fetchedRules.filter(
            (rule) => rule.status !== KodyRulesStatus.DELETED,
        );

        if (rules.length === 0) {
            this.logger.log({
                message: 'No Kody rules found for organization',
                context: CentralizedConfigDownloadUseCase.name,
                metadata: { teamId, organizationId },
            });
            return entries;
        }

        const entryPaths = new Set<string>();

        for (const rule of rules) {
            const baseEntryPath = this.getRuleEntryPath(
                rule,
                repositoryMapping,
            );
            const entryPath = baseEntryPath
                ? this.getUniquePath(baseEntryPath, entryPaths)
                : null;

            if (!entryPath) {
                this.logger.warn({
                    message:
                        'Skipping Kody rule export because entry path could not be resolved',
                    context: CentralizedConfigDownloadUseCase.name,
                    metadata: {
                        teamId,
                        ruleId: rule.uuid,
                        centralizedPath: rule.centralizedConfig?.path,
                        repositoryId: rule.repositoryId,
                        directoryId: rule.directoryId,
                    },
                });
                continue;
            }

            if (options.markRulesAsPendingWithSourcePath) {
                await this.ensureRulePendingWithSourcePath(
                    rule,
                    entryPath,
                    organizationId,
                    user,
                    options.skipAuthorization,
                );
            }

            entries.push({
                path: entryPath,
                content: this.formatRuleToYaml(rule),
            });
        }

        return entries;
    }

    private formatRuleToYaml(rule: IKodyRule): string {
        const ruleForYaml = {
            title: rule.title,
            rule: rule.rule,
            ...(rule.severity ? { severity: rule.severity } : {}),
            ...(rule.scope ? { scope: rule.scope } : {}),
            ...(rule.path ? { path: rule.path } : {}),
            ...(rule.examples ? { examples: rule.examples } : {}),
            ...(rule.inheritance ? { inheritance: rule.inheritance } : {}),
        };

        return yaml.dump(ruleForYaml);
    }

    private async ensureRulePendingWithSourcePath(
        rule: IKodyRule,
        sourcePath: string,
        organizationId: string,
        user: Partial<IUser>,
        skipAuthorization?: boolean,
    ): Promise<void> {
        const currentPath = rule.centralizedConfig?.path;
        const pendingStatus = currentPath
            ? KodyRuleCentralizedStatus.PENDING_EDIT
            : KodyRuleCentralizedStatus.PENDING_ADD;

        const shouldUpdateRule =
            rule.centralizedConfig?.status !== pendingStatus ||
            currentPath !== sourcePath;

        if (!shouldUpdateRule || !rule.uuid) {
            return;
        }

        await this.createOrUpdateKodyRulesUseCase.execute(
            {
                ...rule,
                uuid: rule.uuid,
                centralizedConfig: {
                    path: sourcePath,
                    status: pendingStatus,
                },
            } as any,
            organizationId,
            {
                // Use the internal sync actor so the centralized PR flow is
                // bypassed. The init PR already contains all Kody Rule files,
                // so we must not create separate PRs for each rule here.
                userId: 'kody',
                userEmail: 'kody@kodus.io',
            },
            skipAuthorization,
        );
    }

    private async getCustomMessagesDiffByScope(
        organizationId: string | undefined,
        teamId: string,
        codeReview: Awaited<
            ReturnType<GetCodeReviewParameterUseCase['execute']>
        >,
    ): Promise<Map<string, CustomMessagesConfig>> {
        const messagesByScope = new Map<string, CustomMessagesConfig>();

        if (!organizationId) {
            return messagesByScope;
        }

        try {
            const rawMessagesByScope = new Map<string, CustomMessagesConfig>();
            const messages = await this.pullRequestMessagesService.find({
                organizationId,
            });

            for (const messageEntity of messages ?? []) {
                const message = messageEntity?.toJson?.() as
                    | IPullRequestMessages
                    | undefined;

                if (!message) {
                    continue;
                }

                const scopeKey = this.getCustomMessagesScopeKey(
                    message.configLevel,
                    message.repositoryId,
                    message.directoryId,
                );

                if (!scopeKey) {
                    continue;
                }

                const customMessages =
                    this.extractCustomMessagesFromMessage(message);

                if (!customMessages) {
                    continue;
                }

                rawMessagesByScope.set(scopeKey, customMessages);
            }

            const defaultCustomMessages = this.normalizeCustomMessages(
                getDefaultKodusConfigFile().customMessages,
            );

            const globalScopeKey = this.getCustomMessagesScopeKeyGlobal();
            const globalResolved = this.mergeCustomMessages(
                defaultCustomMessages,
                rawMessagesByScope.get(globalScopeKey),
            );
            const globalDiff = this.diffCustomMessages(
                defaultCustomMessages,
                globalResolved,
            );

            if (globalDiff) {
                messagesByScope.set(globalScopeKey, globalDiff);
            }

            for (const repo of codeReview?.configValue?.repositories ?? []) {
                const repoId = String(repo.id);
                const repoScopeKey =
                    this.getCustomMessagesScopeKeyRepository(repoId);

                const repoResolved = this.mergeCustomMessages(
                    globalResolved,
                    rawMessagesByScope.get(repoScopeKey),
                );
                const repoDiff = this.diffCustomMessages(
                    globalResolved,
                    repoResolved,
                );

                if (repoDiff) {
                    messagesByScope.set(repoScopeKey, repoDiff);
                }

                const getPath = (dir: any): string =>
                    dir.folders?.[0]?.path ?? dir.path ?? '';

                const directories = [...(repo.directories ?? [])]
                    .filter((dir) => Boolean(dir?.id))
                    .sort(
                        (a, b) =>
                            this.getDirectoryDepth(getPath(a)) -
                            this.getDirectoryDepth(getPath(b)),
                    );

                const resolvedByPath = new Map<string, CustomMessagesConfig>();

                for (const dir of directories) {
                    const directoryPath = this.normalizeDirectoryPath(
                        getPath(dir),
                    );
                    const parentResolved =
                        this.findNearestParentCustomMessages(
                            directoryPath,
                            resolvedByPath,
                        ) || repoResolved;

                    const dirScopeKey = this.getCustomMessagesScopeKeyDirectory(
                        repoId,
                        String(dir.id),
                    );
                    const dirResolved = this.mergeCustomMessages(
                        parentResolved,
                        rawMessagesByScope.get(dirScopeKey),
                    );
                    const dirDiff = this.diffCustomMessages(
                        parentResolved,
                        dirResolved,
                    );

                    if (dirDiff) {
                        messagesByScope.set(dirScopeKey, dirDiff);
                    }

                    if (directoryPath) {
                        resolvedByPath.set(directoryPath, dirResolved);
                    }
                }
            }
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to fetch custom messages for centralized config download',
                context: CentralizedConfigDownloadUseCase.name,
                metadata: {
                    teamId,
                    organizationId,
                    errorMessage: this.getErrorMessage(error),
                },
            });
        }

        return messagesByScope;
    }

    private extractCustomMessagesFromMessage(
        message: IPullRequestMessages,
    ): CustomMessagesConfig | null {
        const customMessages: CustomMessagesConfig = {};

        if (
            message.startReviewMessage &&
            this.hasDefinedValues(message.startReviewMessage)
        ) {
            customMessages.startReviewMessage = {
                content: message.startReviewMessage.content,
                status: message.startReviewMessage.status,
            };
        }

        if (
            message.endReviewMessage &&
            this.hasDefinedValues(message.endReviewMessage)
        ) {
            customMessages.endReviewMessage = {
                content: message.endReviewMessage.content,
                status: message.endReviewMessage.status,
            };
        }

        if (
            message.globalSettings &&
            this.hasDefinedValues(message.globalSettings)
        ) {
            customMessages.globalSettings = {
                hideComments: message.globalSettings.hideComments,
                suggestionCopyPrompt:
                    message.globalSettings.suggestionCopyPrompt,
            };
        }

        return Object.keys(customMessages).length > 0 ? customMessages : null;
    }

    private normalizeCustomMessages(
        customMessages?: KodusConfigFile['customMessages'],
    ): CustomMessagesConfig {
        const normalized: CustomMessagesConfig = {};

        if (customMessages?.startReviewMessage) {
            normalized.startReviewMessage = customMessages.startReviewMessage;
        }

        if (customMessages?.endReviewMessage) {
            normalized.endReviewMessage = customMessages.endReviewMessage;
        }

        if (customMessages?.globalSettings) {
            normalized.globalSettings = customMessages.globalSettings;
        }

        return normalized;
    }

    private mergeCustomMessages(
        base: CustomMessagesConfig,
        override?: CustomMessagesConfig,
    ): CustomMessagesConfig {
        return deepMerge(
            this.normalizeCustomMessages(base),
            this.normalizeCustomMessages(override),
        );
    }

    private diffCustomMessages(
        base: CustomMessagesConfig,
        target: CustomMessagesConfig,
    ): CustomMessagesConfig | null {
        const diff = deepDifference(base, target) as CustomMessagesConfig;
        return this.isEmptyObject(diff) ? null : diff;
    }

    private getDirectoryDepth(path?: string): number {
        const normalized = this.normalizeDirectoryPath(path);
        if (!normalized) {
            return 0;
        }

        return normalized.split('/').filter(Boolean).length;
    }

    private findNearestParentCustomMessages(
        directoryPath: string,
        resolvedByPath: Map<string, CustomMessagesConfig>,
    ): CustomMessagesConfig | null {
        if (!directoryPath) {
            return null;
        }

        let currentPath = directoryPath;

        while (currentPath.includes('/')) {
            currentPath = currentPath.slice(0, currentPath.lastIndexOf('/'));

            const parentResolved = resolvedByPath.get(currentPath);
            if (parentResolved) {
                return parentResolved;
            }
        }

        return null;
    }

    private isEmptyObject(value: object | null | undefined): boolean {
        if (!value) return true;
        return Object.keys(value).length === 0;
    }

    private hasDefinedValues(value?: any): boolean {
        if (value === undefined || value === null || value === '') {
            return false;
        }

        if (typeof value !== 'object') {
            return true;
        }

        if (Array.isArray(value)) {
            return value.some((item) => this.hasDefinedValues(item));
        }

        return Object.values(value).some((item) => this.hasDefinedValues(item));
    }

    private getCustomMessagesScopeKey(
        configLevel: ConfigLevel,
        repositoryId?: string,
        directoryId?: string,
    ): string | null {
        if (configLevel === ConfigLevel.GLOBAL) {
            return this.getCustomMessagesScopeKeyGlobal();
        }

        if (configLevel === ConfigLevel.REPOSITORY && repositoryId) {
            return this.getCustomMessagesScopeKeyRepository(repositoryId);
        }

        if (
            configLevel === ConfigLevel.DIRECTORY &&
            repositoryId &&
            directoryId
        ) {
            return this.getCustomMessagesScopeKeyDirectory(
                repositoryId,
                directoryId,
            );
        }

        return null;
    }

    private getCustomMessagesScopeKeyGlobal(): string {
        return 'global';
    }

    private getCustomMessagesScopeKeyRepository(repositoryId: string): string {
        return `repository:${repositoryId}`;
    }

    private getCustomMessagesScopeKeyDirectory(
        repositoryId: string,
        directoryId: string,
    ): string {
        return `directory:${repositoryId}:${directoryId}`;
    }

    private createConfigEntryWithCustomMessages(
        path: string,
        yamlString?: string,
        customMessages?: NonNullable<KodusConfigFile['customMessages']>,
    ): FileEntry | null {
        const content = this.buildConfigContentWithCustomMessages(
            yamlString,
            customMessages,
        );

        if (!content) {
            return null;
        }

        return { path, content };
    }

    private buildConfigContentWithCustomMessages(
        yamlString?: string,
        customMessages?: NonNullable<KodusConfigFile['customMessages']>,
    ): string | null {
        if (!customMessages || Object.keys(customMessages).length === 0) {
            return yamlString?.trim() ? yamlString : null;
        }

        const configObject = this.parseConfigYaml(yamlString);
        configObject.customMessages = customMessages;

        if (Object.keys(configObject).length === 0) {
            return null;
        }

        return yaml.dump(configObject);
    }

    private parseConfigYaml(yamlString?: string): KodusConfigFile {
        if (!yamlString || !yamlString.trim()) {
            return {} as KodusConfigFile;
        }

        try {
            const parsed = yaml.load(yamlString);

            if (parsed && typeof parsed === 'object') {
                return parsed as KodusConfigFile;
            }
        } catch {
            return {} as KodusConfigFile;
        }

        return {} as KodusConfigFile;
    }

    private normalizeDirectoryPath(path?: string): string {
        if (!path) return '';
        return path.replace(/^\/+/, '').replace(/\/+$/, '');
    }

    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private getRuleFileName(rule: IKodyRule): string {
        const preferredName =
            this.centralizedConfigPrService.sanitizeFileName(
                rule.title,
                'rule',
            ) + (rule.uuid ? `-${rule.uuid.slice(0, 8)}` : '');

        return `${preferredName}.yml`;
    }

    private getRuleEntryPath(
        rule: IKodyRule,
        repositoryMapping: Map<
            string,
            {
                repoFolderName: string;
                directoriesById: Map<string, string>;
                groupFolderNamesById: Map<string, string>;
            }
        >,
    ): string | null {
        const rulesDirectory =
            rule.type === KodyRulesType.MEMORY ? 'memories' : 'review';
        const fileName = this.getRuleFileName(rule);

        if (!rule.repositoryId || rule.repositoryId === 'global') {
            return `.kody-rules/${rulesDirectory}/${fileName}`;
        }

        const repoScope = repositoryMapping.get(String(rule.repositoryId));
        const repoFolderName = repoScope?.repoFolderName || rule.repositoryId;

        if (rule.directoryId) {
            const groupFolderName = repoScope?.groupFolderNamesById.get(
                String(rule.directoryId),
            );
            if (!groupFolderName) {
                return null;
            }
            return this.centralizedConfigPrService.buildDirectoryGroupRulesPath(
                repoFolderName,
                groupFolderName,
                rulesDirectory,
                fileName,
            );
        }

        return this.centralizedConfigPrService.buildCentralizedPath({
            repositoryFolder: repoFolderName,
            relativePath: `.kody-rules/${rulesDirectory}/${fileName}`,
        });
    }

    private getUniquePath(path: string, usedPaths: Set<string>): string {
        if (!path) return path;

        if (!usedPaths.has(path)) {
            usedPaths.add(path);
            return path;
        }

        const suffix = path.endsWith('.yaml') ? '.yaml' : '.yml';
        const pathWithoutExt = path.replace(/\.(yml|yaml)$/i, '');

        let index = 2;
        let candidate = `${pathWithoutExt}-${index}${suffix}`;

        while (usedPaths.has(candidate)) {
            index++;
            candidate = `${pathWithoutExt}-${index}${suffix}`;
        }

        usedPaths.add(candidate);
        return candidate;
    }
}
