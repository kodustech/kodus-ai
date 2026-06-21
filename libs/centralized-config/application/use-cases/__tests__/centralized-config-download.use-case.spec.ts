import { promises as fsPromises } from 'fs';
import * as yaml from 'js-yaml';

import { CentralizedConfigDownloadUseCase } from '../centralized-config-download.use-case';
import { CentralizedConfigPrService } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import {
    ConfigLevel,
    PullRequestMessageStatus,
} from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';

describe('CentralizedConfigDownloadUseCase', () => {
    const user = {
        uuid: 'user-1',
        organization: {
            uuid: 'org-1',
        },
    } as any;

    const teamId = 'team-1';

    beforeEach(() => {
        jest.restoreAllMocks();
        jest.spyOn(fsPromises, 'readFile').mockResolvedValue('version: 1\n');
    });

    const centralizedConfigPrServiceMock: Pick<
        CentralizedConfigPrService,
        'sanitizeFileName' | 'buildCentralizedPath'
    > = {
        sanitizeFileName: ((
            name?: string,
            fallback = 'item',
            maxLength = 30,
        ) => {
            const normalized = (name || '')
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, maxLength);

            return normalized || fallback;
        }) as CentralizedConfigPrService['sanitizeFileName'],
        buildCentralizedPath: ((params: {
            repositoryFolder: string;
            relativePath: string;
        }) => {
            if (params.repositoryFolder === 'global') {
                return params.relativePath;
            }

            return `${params.repositoryFolder}/${params.relativePath}`;
        }) as CentralizedConfigPrService['buildCentralizedPath'],
    };

    it('adds scoped custom messages to global/repository/directory exported configs', async () => {
        const getCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue({
                configValue: {
                    repositories: [
                        {
                            id: 'repo-1',
                            name: 'repo-one',
                            isSelected: true,
                            directories: [
                                {
                                    id: 'dir-1',
                                    path: '/src',
                                    isSelected: true,
                                    folders: [{ path: '/src' }],
                                },
                            ],
                        },
                    ],
                },
            }),
        };

        const generateKodusConfigFileUseCase = {
            execute: jest
                .fn()
                .mockImplementation(
                    async (
                        _teamId: string,
                        repositoryId?: string,
                        directoryId?: string,
                    ) => {
                        if (repositoryId === 'global') {
                            return {
                                yamlString: 'languageResultPrompt: english\n',
                            };
                        }

                        if (repositoryId === 'repo-1' && !directoryId) {
                            return { yamlString: 'repositorySetting: true\n' };
                        }

                        if (
                            repositoryId === 'repo-1' &&
                            directoryId === 'dir-1'
                        ) {
                            return { yamlString: 'directorySetting: true\n' };
                        }

                        return { yamlString: '' };
                    },
                ),
        };

        const findRulesInOrganizationByRuleFilterKodyRulesUseCase = {
            execute: jest.fn().mockResolvedValue([]),
        };

        const pullRequestMessagesService = {
            find: jest.fn().mockResolvedValue([
                {
                    toJson: () => ({
                        configLevel: ConfigLevel.GLOBAL,
                        repositoryId: 'global',
                        startReviewMessage: {
                            status: PullRequestMessageStatus.EVERY_PUSH,
                            content: 'global-start',
                        },
                    }),
                },
                {
                    toJson: () => ({
                        configLevel: ConfigLevel.REPOSITORY,
                        repositoryId: 'repo-1',
                        endReviewMessage: {
                            status: PullRequestMessageStatus.ONLY_WHEN_OPENED,
                            content: 'repo-end',
                        },
                    }),
                },
                {
                    toJson: () => ({
                        configLevel: ConfigLevel.DIRECTORY,
                        repositoryId: 'repo-1',
                        directoryId: 'dir-1',
                        globalSettings: {
                            hideComments: true,
                            suggestionCopyPrompt: false,
                        },
                    }),
                },
            ]),
        };

        const createOrUpdateKodyRulesUseCase = {
            execute: jest.fn(),
        };

        const useCase = new CentralizedConfigDownloadUseCase(
            getCodeReviewParameterUseCase as any,
            generateKodusConfigFileUseCase as any,
            findRulesInOrganizationByRuleFilterKodyRulesUseCase as any,
            createOrUpdateKodyRulesUseCase as any,
            pullRequestMessagesService as any,
            centralizedConfigPrServiceMock as CentralizedConfigPrService,
        );

        const entries = await useCase.execute(user, teamId, {
            skipAuthorization: true,
        });

        const globalEntry = entries.find((e) => e.path === 'kodus-config.yml');
        const repoEntry = entries.find(
            (e) => e.path === 'repo-one/kodus-config.yml',
        );
        const dirConfigEntry = entries.find(
            (e) => e.path === 'repo-one/src/kodus-config.yml',
        );

        expect(globalEntry).toBeDefined();
        expect(repoEntry).toBeDefined();
        expect(dirConfigEntry).toBeDefined();
        expect(
            entries.some((e) => e.path.includes('folders.yml')),
        ).toBe(false);

        const globalConfig = yaml.load(globalEntry.content) as any;
        const repoConfig = yaml.load(repoEntry.content) as any;
        const dirConfig = yaml.load(dirConfigEntry.content) as any;

        expect(globalConfig.customMessages.startReviewMessage.content).toBe(
            'global-start',
        );
        expect(repoConfig.customMessages.endReviewMessage.content).toBe(
            'repo-end',
        );
        expect(dirConfig.customMessages.globalSettings).toEqual({
            hideComments: true,
            suggestionCopyPrompt: false,
        });
    });

    it('creates config file when scope has only custom messages and empty base config', async () => {
        const getCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue({
                configValue: {
                    repositories: [
                        {
                            id: 'repo-1',
                            name: 'repo-one',
                            isSelected: true,
                            directories: [],
                        },
                    ],
                },
            }),
        };

        const generateKodusConfigFileUseCase = {
            execute: jest
                .fn()
                .mockImplementation(
                    async (_teamId: string, repositoryId?: string) => {
                        if (repositoryId === 'global') {
                            return {
                                yamlString: 'languageResultPrompt: english\n',
                            };
                        }

                        if (repositoryId === 'repo-1') {
                            return { yamlString: '' };
                        }

                        return { yamlString: '' };
                    },
                ),
        };

        const findRulesInOrganizationByRuleFilterKodyRulesUseCase = {
            execute: jest.fn().mockResolvedValue([]),
        };

        const pullRequestMessagesService = {
            find: jest.fn().mockResolvedValue([
                {
                    toJson: () => ({
                        configLevel: ConfigLevel.REPOSITORY,
                        repositoryId: 'repo-1',
                        startReviewMessage: {
                            status: PullRequestMessageStatus.EVERY_PUSH,
                            content: 'repo-only-message',
                        },
                    }),
                },
            ]),
        };

        const createOrUpdateKodyRulesUseCase = {
            execute: jest.fn(),
        };

        const useCase = new CentralizedConfigDownloadUseCase(
            getCodeReviewParameterUseCase as any,
            generateKodusConfigFileUseCase as any,
            findRulesInOrganizationByRuleFilterKodyRulesUseCase as any,
            createOrUpdateKodyRulesUseCase as any,
            pullRequestMessagesService as any,
            centralizedConfigPrServiceMock as CentralizedConfigPrService,
        );

        const entries = await useCase.execute(user, teamId, {
            skipAuthorization: true,
        });

        const repoEntry = entries.find(
            (entry) => entry.path === 'repo-one/kodus-config.yml',
        );

        expect(repoEntry).toBeDefined();

        const repoConfig = yaml.load(repoEntry.content) as any;
        expect(repoConfig.customMessages.startReviewMessage.content).toBe(
            'repo-only-message',
        );
        expect(Object.keys(repoConfig)).toEqual(['customMessages']);
    });

    it('exports only custom message diffs for inherited scopes', async () => {
        const getCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue({
                configValue: {
                    repositories: [
                        {
                            id: 'repo-1',
                            name: 'repo-one',
                            isSelected: true,
                            directories: [
                                {
                                    id: 'dir-parent',
                                    path: '/src',
                                    isSelected: true,
                                    folders: [{ path: '/src' }],
                                },
                                {
                                    id: 'dir-child',
                                    path: '/src/app',
                                    isSelected: true,
                                    folders: [{ path: '/src/app' }],
                                },
                            ],
                        },
                    ],
                },
            }),
        };

        const generateKodusConfigFileUseCase = {
            execute: jest
                .fn()
                .mockImplementation(
                    async (_teamId: string, repositoryId?: string) => {
                        if (repositoryId === 'global') {
                            return {
                                yamlString: 'languageResultPrompt: english\n',
                            };
                        }

                        return { yamlString: '' };
                    },
                ),
        };

        const findRulesInOrganizationByRuleFilterKodyRulesUseCase = {
            execute: jest.fn().mockResolvedValue([]),
        };

        const pullRequestMessagesService = {
            find: jest.fn().mockResolvedValue([
                {
                    toJson: () => ({
                        configLevel: ConfigLevel.GLOBAL,
                        repositoryId: 'global',
                        startReviewMessage: {
                            status: PullRequestMessageStatus.EVERY_PUSH,
                            content: 'global-custom',
                        },
                    }),
                },
                {
                    toJson: () => ({
                        configLevel: ConfigLevel.REPOSITORY,
                        repositoryId: 'repo-1',
                        startReviewMessage: {
                            status: PullRequestMessageStatus.EVERY_PUSH,
                            content: 'global-custom',
                        },
                    }),
                },
                {
                    toJson: () => ({
                        configLevel: ConfigLevel.DIRECTORY,
                        repositoryId: 'repo-1',
                        directoryId: 'dir-parent',
                        startReviewMessage: {
                            status: PullRequestMessageStatus.EVERY_PUSH,
                            content: 'parent-custom',
                        },
                    }),
                },
                {
                    toJson: () => ({
                        configLevel: ConfigLevel.DIRECTORY,
                        repositoryId: 'repo-1',
                        directoryId: 'dir-child',
                        startReviewMessage: {
                            status: PullRequestMessageStatus.EVERY_PUSH,
                            content: 'parent-custom',
                        },
                    }),
                },
            ]),
        };

        const createOrUpdateKodyRulesUseCase = {
            execute: jest.fn(),
        };

        const useCase = new CentralizedConfigDownloadUseCase(
            getCodeReviewParameterUseCase as any,
            generateKodusConfigFileUseCase as any,
            findRulesInOrganizationByRuleFilterKodyRulesUseCase as any,
            createOrUpdateKodyRulesUseCase as any,
            pullRequestMessagesService as any,
            centralizedConfigPrServiceMock as CentralizedConfigPrService,
        );

        const entries = await useCase.execute(user, teamId, {
            skipAuthorization: true,
        });

        const globalEntry = entries.find((e) => e.path === 'kodus-config.yml');
        const repoEntry = entries.find(
            (entry) => entry.path === 'repo-one/kodus-config.yml',
        );
        const parentDirConfigEntry = entries.find(
            (entry) => entry.path === 'repo-one/src/kodus-config.yml',
        );
        const childDirConfigEntry = entries.find(
            (entry) => entry.path === 'repo-one/src%2Fapp/kodus-config.yml',
        );

        expect(globalEntry).toBeDefined();
        expect(parentDirConfigEntry).toBeDefined();
        expect(repoEntry).toBeUndefined();
        expect(childDirConfigEntry).toBeUndefined();
        expect(
            entries.some((e) => e.path.includes('folders.yml')),
        ).toBe(false);

        const globalConfig = yaml.load(globalEntry.content) as any;
        const parentDirConfig = yaml.load(parentDirConfigEntry.content) as any;

        expect(globalConfig.customMessages.startReviewMessage.content).toBe(
            'global-custom',
        );
        expect(parentDirConfig.customMessages.startReviewMessage.content).toBe(
            'parent-custom',
        );
    });

    it('marks rules with centralized pending status and source path internally but does not expose them in downloaded yaml', async () => {
        const getCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue({
                configValue: {
                    repositories: [
                        {
                            id: 'repo-1',
                            name: 'repo-one',
                            isSelected: true,
                            directories: [],
                        },
                    ],
                },
            }),
        };

        const generateKodusConfigFileUseCase = {
            execute: jest.fn().mockResolvedValue({
                yamlString: 'languageResultPrompt: english\n',
            }),
        };

        const findRulesInOrganizationByRuleFilterKodyRulesUseCase = {
            execute: jest.fn().mockResolvedValue([
                {
                    uuid: 'rule-1',
                    title: 'Avoid debug logs',
                    rule: 'Do not commit debug logs',
                    severity: 'medium',
                    status: 'active',
                    type: 'standard',
                    scope: 'file',
                    path: '**/*',
                    examples: [],
                    inheritance: {
                        inheritable: true,
                        include: [],
                        exclude: [],
                    },
                    repositoryId: 'repo-1',
                },
            ]),
        };

        const createOrUpdateKodyRulesUseCase = {
            execute: jest.fn().mockResolvedValue({ uuid: 'rule-1' }),
        };

        const pullRequestMessagesService = {
            find: jest.fn().mockResolvedValue([]),
        };

        const useCase = new CentralizedConfigDownloadUseCase(
            getCodeReviewParameterUseCase as any,
            generateKodusConfigFileUseCase as any,
            findRulesInOrganizationByRuleFilterKodyRulesUseCase as any,
            createOrUpdateKodyRulesUseCase as any,
            pullRequestMessagesService as any,
            centralizedConfigPrServiceMock as CentralizedConfigPrService,
        );

        const entries = await useCase.execute(user, teamId, {
            skipAuthorization: true,
            markRulesAsPendingWithSourcePath: true,
        });

        const ruleEntry = entries.find((entry) =>
            entry.path.startsWith('repo-one/.kody-rules/review/'),
        );

        expect(ruleEntry).toBeDefined();
        expect(createOrUpdateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                uuid: 'rule-1',
                centralizedConfig: {
                    path: ruleEntry!.path,
                    status: 'pending_add',
                },
            }),
            'org-1',
            {
                userId: 'kody',
                userEmail: 'kody@kodus.io',
            },
            true,
        );

        const exportedRule = yaml.load(ruleEntry!.content) as any;
        expect(exportedRule.status).toBeUndefined();
        expect(exportedRule.sourcePath).toBeUndefined();
    });
});
