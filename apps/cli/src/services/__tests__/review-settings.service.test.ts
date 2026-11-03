import { beforeEach, describe, expect, it, vi } from 'vitest';

// The team's selected repositories (owner/repo), which repository references
// are resolved against.
vi.mock('../api/cockpit.api.js', () => ({
    cockpitApi: {
        listSelectedRepositories: vi.fn().mockResolvedValue([
            { id: 'repo-1', name: 'kodus-ai', full_name: 'kodustech/kodus-ai' },
            { id: 'repo-2', name: 'docs', full_name: 'kodustech/docs' },
            { id: 'repo-3', name: 'archived', full_name: 'kodustech/archived' },
        ]),
    },
}));

vi.mock('../api/index.js', () => ({
    api: {
        config: {
            getCodeReviewScopes: vi.fn(),
            getFormattedCodeReviewParameter: vi.fn(),
            saveCodeReviewConfig: vi.fn(),
            getLLMConfigStatus: vi.fn(),
            testByokModel: vi.fn(),
        },
    },
}));

vi.mock('../user-context.service.js', () => ({
    userContextService: {
        resolve: vi.fn(),
        requireUserToken: vi.fn(),
    },
}));

vi.mock('../git.service.js', () => ({
    gitService: {
        isGitRepository: vi.fn(),
        extractOrgRepo: vi.fn(),
    },
}));

import { api } from '../api/index.js';
import { cockpitApi } from '../api/cockpit.api.js';
import { gitService } from '../git.service.js';
import { readLeaf, reviewSettingsService } from '../review-settings.service.js';
import { userContextService } from '../user-context.service.js';

const configApi = vi.mocked(api.config);
const userContext = vi.mocked(userContextService);
const git = vi.mocked(gitService);

const CTX = {
    accessToken: 'eyJ.user.token',
    organizationId: 'org-1',
    teamId: 'team-1',
    teamName: 'Core',
};

const SCOPES = [
    {
        id: 'repo-1',
        name: 'kodus-ai',
        isSelected: true,
        directories: [{ id: 'dir-1', name: 'web', paths: ['/apps/web'] }],
    },
    {
        id: 'repo-2',
        name: 'docs',
        isSelected: true,
        directories: [],
    },
    {
        id: 'repo-3',
        name: 'archived',
        isSelected: false,
        directories: [],
    },
];

const leaf = (
    value: unknown,
    level: string,
    overridden?: [unknown, string],
) => ({
    value,
    level,
    ...(overridden
        ? { overriddenValue: overridden[0], overriddenLevel: overridden[1] }
        : {}),
});

const FORMATTED = {
    configValue: {
        configs: {
            runOnDraft: leaf(true, 'default'),
            suggestionControl: {
                severityLevelFilter: leaf('high', 'global', [
                    'medium',
                    'default',
                ]),
            },
        },
        repositories: [
            {
                id: 'repo-1',
                name: 'kodus-ai',
                kodusConfigFile: { status: 'loaded' },
                configs: {
                    runOnDraft: leaf(false, 'repository', [true, 'default']),
                    ignorePaths: leaf(['dist/**'], 'repository_file', [
                        [],
                        'default',
                    ]),
                    suggestionControl: {
                        severityLevelFilter: leaf('high', 'global', [
                            'medium',
                            'default',
                        ]),
                    },
                    byokModelId: leaf('model-b', 'repository', ['', 'default']),
                },
                directories: [
                    {
                        id: 'dir-1',
                        configs: {
                            runOnDraft: leaf(true, 'directory', [
                                false,
                                'repository',
                            ]),
                        },
                    },
                ],
            },
        ],
    },
};

describe('reviewSettingsService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        userContext.resolve.mockResolvedValue(CTX);
        userContext.requireUserToken.mockResolvedValue(CTX.accessToken);
        configApi.getCodeReviewScopes.mockResolvedValue(SCOPES);
        configApi.getFormattedCodeReviewParameter.mockResolvedValue(
            FORMATTED as never,
        );
        configApi.saveCodeReviewConfig.mockResolvedValue({});
    });

    describe('scope resolution', () => {
        it('resolves global without listing repositories', async () => {
            const scope = await reviewSettingsService.resolveScope(CTX, {
                repository: 'global',
            });
            expect(scope).toEqual({ level: 'global' });
            expect(configApi.getCodeReviewScopes).not.toHaveBeenCalled();
        });

        it('matches a repository by owner/repo, by name and by id', async () => {
            for (const reference of [
                'kodustech/kodus-ai',
                'kodus-ai',
                'repo-1',
            ]) {
                const scope = await reviewSettingsService.resolveScope(CTX, {
                    repository: reference,
                });
                expect(scope).toMatchObject({
                    level: 'repository',
                    repositoryId: 'repo-1',
                });
            }
        });

        it("reads '.' from the git remote", async () => {
            git.isGitRepository.mockResolvedValue(true);
            git.extractOrgRepo.mockResolvedValue({
                org: 'kodustech',
                repo: 'docs',
            } as never);
            const scope = await reviewSettingsService.resolveScope(CTX, {
                repository: '.',
            });
            expect(scope.repositoryId).toBe('repo-2');
        });

        it('resolves a repository that still inherits global settings', async () => {
            // isSelected: false is "Inherits Global" in the settings sidebar;
            // the repository is still listed and editable there.
            await expect(
                reviewSettingsService.resolveScope(CTX, {
                    repository: 'archived',
                }),
            ).resolves.toEqual(
                expect.objectContaining({ level: 'repository' }),
            );
        });

        it('refuses a repository the team does not review', async () => {
            await expect(
                reviewSettingsService.resolveScope(CTX, {
                    repository: 'unknown-repo',
                }),
            ).rejects.toThrow(/is not selected for team/);
        });

        it("never lands on another owner's repository with the same name", async () => {
            // Only kodustech/kodus-ai is selected: other-org/kodus-ai must
            // fail, not resolve through its last path segment.
            await expect(
                reviewSettingsService.resolveScope(CTX, {
                    repository: 'other-org/kodus-ai',
                }),
            ).rejects.toThrow(/is not selected for team/);
        });

        it('refuses an ambiguous name and asks for the id', async () => {
            vi.mocked(
                cockpitApi.listSelectedRepositories,
            ).mockResolvedValueOnce([
                {
                    id: 'repo-1',
                    name: 'kodus-ai',
                    full_name: 'kodustech/kodus-ai',
                },
                {
                    id: 'repo-9',
                    name: 'kodus-ai',
                    full_name: 'other-org/kodus-ai',
                },
            ]);
            configApi.getCodeReviewScopes.mockResolvedValue([
                ...SCOPES,
                {
                    id: 'repo-9',
                    name: 'kodus-ai',
                    isSelected: true,
                    directories: [],
                },
            ]);
            await expect(
                reviewSettingsService.resolveScope(CTX, {
                    repository: 'kodus-ai',
                }),
            ).rejects.toThrow(/more than one repository/);
        });

        it('matches a directory by path however it is written', async () => {
            const scope = await reviewSettingsService.resolveScope(CTX, {
                repository: 'kodus-ai',
                directory: './apps/web/',
            });
            expect(scope).toMatchObject({
                level: 'directory',
                directoryId: 'dir-1',
                directoryPath: 'apps/web',
            });
        });

        it('creates a directory scope only when asked', async () => {
            await expect(
                reviewSettingsService.resolveScope(CTX, {
                    repository: 'kodus-ai',
                    directory: 'apps/api',
                }),
            ).rejects.toThrow(/--create-directory/);

            const scope = await reviewSettingsService.resolveScope(
                CTX,
                { repository: 'kodus-ai', directory: 'apps/api' },
                { createDirectory: true },
            );
            expect(scope).toMatchObject({
                level: 'directory',
                directoryPath: 'apps/api',
            });
            expect(scope.directoryId).toBeUndefined();
        });

        it('refuses a directory on global', async () => {
            await expect(
                reviewSettingsService.resolveScope(CTX, {
                    repository: 'global',
                    directory: 'apps',
                }),
            ).rejects.toThrow(/needs a repository/);
        });
    });

    describe('show', () => {
        it('reports every key with its value and the level it comes from', async () => {
            const result = await reviewSettingsService.show({
                repository: 'kodus-ai',
            });

            const byKey = Object.fromEntries(
                result.settings.map((setting) => [setting.key, setting]),
            );
            expect(byKey.runOnDraft).toMatchObject({
                value: false,
                level: 'repository',
                overriddenValue: true,
                overriddenLevel: 'default',
            });
            expect(
                byKey['suggestionControl.severityLevelFilter'],
            ).toMatchObject({ value: 'high', level: 'global' });
            expect(byKey.ignorePaths.level).toBe('repository_file');
            // A key no level has set yet still shows up, as unset default.
            expect(byKey['suggestionControl.severityLimits.low']).toMatchObject(
                {
                    value: undefined,
                    level: 'default',
                },
            );
            expect(result.model).toEqual({
                value: 'model-b',
                level: 'repository',
            });
            expect(result.kodusConfigFile).toBe('loaded');
            expect(result.team).toBe('Core');
        });

        it('reads the directory level from the directory node', async () => {
            const result = await reviewSettingsService.show({
                repository: 'kodus-ai',
                directory: 'apps/web',
            });
            expect(
                result.settings.find((setting) => setting.key === 'runOnDraft'),
            ).toMatchObject({ value: true, level: 'directory' });
        });

        it('passes --no-file-overlay through', async () => {
            await reviewSettingsService.show(
                { repository: 'global' },
                { includeFileOverlay: false },
            );
            expect(
                configApi.getFormattedCodeReviewParameter,
            ).toHaveBeenCalledWith(CTX.accessToken, 'team-1', {
                includeFileOverlay: false,
            });
        });

        it('passes --team to the user context', async () => {
            await reviewSettingsService.show({
                repository: 'global',
                team: 'Infra',
            });
            expect(userContext.resolve).toHaveBeenCalledWith(
                'Code review settings',
                { team: 'Infra' },
            );
        });
    });

    describe('set', () => {
        it('saves only the changed key at the repository, like the settings page', async () => {
            const result = await reviewSettingsService.set(
                { repository: 'kodus-ai' },
                'suggestionControl.severityLimits.high',
                '2',
            );

            expect(configApi.saveCodeReviewConfig).toHaveBeenCalledWith(
                CTX.accessToken,
                {
                    teamId: 'team-1',
                    configValue: {
                        suggestionControl: { severityLimits: { high: 2 } },
                    },
                    repositoryId: 'repo-1',
                    directoryId: undefined,
                    directoryPaths: undefined,
                },
            );
            expect(result).toMatchObject({
                key: 'suggestionControl.severityLimits.high',
                value: 2,
            });
        });

        it('fails when the plan left linkedRepositories out of the save', async () => {
            // The config reads back without the value: the API dropped it.
            await expect(
                reviewSettingsService.set(
                    { repository: 'kodus-ai' },
                    'linkedRepositories',
                    '[{"repository":"acme/docs"}]',
                ),
            ).rejects.toMatchObject({
                code: 'API_REQUEST_FAILED',
                message: expect.stringContaining('Teams and Enterprise'),
            });
            expect(configApi.saveCodeReviewConfig).toHaveBeenCalledTimes(1);
        });

        it('accepts linkedRepositories when the value reads back', async () => {
            const value = [{ repository: 'acme/docs' }];
            configApi.getFormattedCodeReviewParameter
                .mockResolvedValueOnce(FORMATTED as never)
                .mockResolvedValue({
                    ...FORMATTED,
                    configValue: {
                        ...(FORMATTED as any).configValue,
                        repositories: (
                            FORMATTED as any
                        ).configValue.repositories.map((repo: any) =>
                            repo.id === 'repo-1'
                                ? {
                                      ...repo,
                                      configs: {
                                          ...repo.configs,
                                          linkedRepositories: {
                                              value,
                                              level: 'repository',
                                          },
                                      },
                                  }
                                : repo,
                        ),
                    },
                } as never);

            await expect(
                reviewSettingsService.set(
                    { repository: 'kodus-ai' },
                    'linkedRepositories',
                    JSON.stringify(value),
                ),
            ).resolves.toMatchObject({ key: 'linkedRepositories' });
        });

        it('checks linkedRepositories at a directory the same command created', async () => {
            const value = [{ repository: 'acme/docs' }];
            // Before the save the directory does not exist; after it, the
            // scopes list it with the id the API gave it.
            configApi.getCodeReviewScopes
                .mockResolvedValueOnce(SCOPES)
                .mockResolvedValue(
                    SCOPES.map((scope) =>
                        scope.id === 'repo-1'
                            ? {
                                  ...scope,
                                  directories: [
                                      ...scope.directories,
                                      {
                                          id: 'dir-new',
                                          name: 'api',
                                          paths: ['/apps/api'],
                                      },
                                  ],
                              }
                            : scope,
                    ),
                );
            const base = FORMATTED as any;
            configApi.getFormattedCodeReviewParameter.mockResolvedValue({
                ...base,
                configValue: {
                    ...base.configValue,
                    repositories: base.configValue.repositories.map(
                        (repo: any) =>
                            repo.id === 'repo-1'
                                ? {
                                      ...repo,
                                      directories: [
                                          ...(repo.directories ?? []),
                                          {
                                              id: 'dir-new',
                                              configs: {
                                                  linkedRepositories: {
                                                      value,
                                                      level: 'directory',
                                                  },
                                              },
                                          },
                                      ],
                                  }
                                : repo,
                    ),
                },
            } as never);

            await expect(
                reviewSettingsService.set(
                    {
                        repository: 'kodus-ai',
                        directory: 'apps/api',
                        createDirectory: true,
                    },
                    'linkedRepositories',
                    JSON.stringify(value),
                ),
            ).resolves.toMatchObject({ key: 'linkedRepositories' });
        });

        it('reads the saved value back without the kodus-config.yml overlay', async () => {
            const value = [{ repository: 'acme/docs' }];
            const base = FORMATTED as any;
            configApi.getFormattedCodeReviewParameter.mockImplementation(
                async (_token: string, _team: string, options?: any) =>
                    ({
                        ...base,
                        configValue: {
                            ...base.configValue,
                            repositories: base.configValue.repositories.map(
                                (repo: any) =>
                                    repo.id === 'repo-1'
                                        ? {
                                              ...repo,
                                              configs: {
                                                  ...repo.configs,
                                                  // The file shows its own value on top
                                                  // of what was saved.
                                                  linkedRepositories:
                                                      options?.includeFileOverlay ===
                                                      false
                                                          ? {
                                                                value,
                                                                level: 'repository',
                                                            }
                                                          : {
                                                                value: [],
                                                                level: 'repository_file',
                                                            },
                                              },
                                          }
                                        : repo,
                            ),
                        },
                    }) as never,
            );

            await expect(
                reviewSettingsService.set(
                    { repository: 'kodus-ai' },
                    'linkedRepositories',
                    JSON.stringify(value),
                ),
            ).resolves.toMatchObject({ key: 'linkedRepositories' });
        });

        it('saves global without a repository id', async () => {
            await reviewSettingsService.set(
                { repository: 'global' },
                'review.enabled',
                'false',
            );
            expect(configApi.saveCodeReviewConfig).toHaveBeenCalledWith(
                CTX.accessToken,
                expect.objectContaining({
                    configValue: { automatedReviewActive: false },
                    repositoryId: undefined,
                }),
            );
        });

        it('saves a directory by id, or by path when creating it', async () => {
            await reviewSettingsService.set(
                { repository: 'kodus-ai', directory: 'apps/web' },
                'runOnDraft',
                'false',
            );
            expect(configApi.saveCodeReviewConfig).toHaveBeenLastCalledWith(
                CTX.accessToken,
                expect.objectContaining({
                    repositoryId: 'repo-1',
                    directoryId: 'dir-1',
                    directoryPaths: undefined,
                }),
            );

            await reviewSettingsService.set(
                {
                    repository: 'kodus-ai',
                    directory: 'apps/api',
                    createDirectory: true,
                },
                'runOnDraft',
                'false',
            );
            expect(configApi.saveCodeReviewConfig).toHaveBeenLastCalledWith(
                CTX.accessToken,
                expect.objectContaining({
                    repositoryId: 'repo-1',
                    directoryId: undefined,
                    directoryPaths: ['apps/api'],
                }),
            );
        });

        it('rejects a bad value before calling the API', async () => {
            await expect(
                reviewSettingsService.set(
                    { repository: 'kodus-ai' },
                    'reviewCadence.type',
                    'weekly',
                ),
            ).rejects.toThrow(/automatic, manual, auto_pause/);
            expect(userContext.resolve).not.toHaveBeenCalled();
            expect(configApi.saveCodeReviewConfig).not.toHaveBeenCalled();
        });

        it('warns when kodus-config.yml keeps overriding the scope', async () => {
            const result = await reviewSettingsService.set(
                { repository: 'kodus-ai' },
                'ignorePaths',
                'build/**',
            );
            expect(result.overriddenByFile).toBe('repository_file');
        });

        it('surfaces a centralized config pull request', async () => {
            configApi.saveCodeReviewConfig.mockResolvedValue({
                mode: 'centralized-pr',
                prUrl: 'https://github.com/o/r/pull/9',
            });
            const result = await reviewSettingsService.set(
                { repository: 'kodus-ai' },
                'runOnDraft',
                'true',
            );
            expect(result.centralized?.prUrl).toBe(
                'https://github.com/o/r/pull/9',
            );
        });
    });

    describe('unset', () => {
        it('fails an unset the plan left out, instead of reporting it reverted', async () => {
            const base = FORMATTED as any;
            // The override is still there after the save.
            configApi.getFormattedCodeReviewParameter.mockResolvedValue({
                ...base,
                configValue: {
                    ...base.configValue,
                    repositories: base.configValue.repositories.map(
                        (repo: any) =>
                            repo.id === 'repo-1'
                                ? {
                                      ...repo,
                                      configs: {
                                          ...repo.configs,
                                          linkedRepositories: {
                                              value: [
                                                  { repository: 'acme/docs' },
                                              ],
                                              level: 'repository',
                                              overriddenValue: [],
                                              overriddenLevel: 'default',
                                          },
                                      },
                                  }
                                : repo,
                    ),
                },
            } as never);

            await expect(
                reviewSettingsService.unset(
                    { repository: 'kodus-ai' },
                    'linkedRepositories',
                ),
            ).rejects.toMatchObject({
                message: expect.stringContaining('override is still in place'),
            });
        });

        it('looks for the override in the saved config, not the file overlay', async () => {
            await reviewSettingsService.unset(
                { repository: 'kodus-ai' },
                'runOnDraft',
            );
            expect(
                configApi.getFormattedCodeReviewParameter,
            ).toHaveBeenCalledWith(CTX.accessToken, 'team-1', {
                includeFileOverlay: false,
            });
        });

        it("saves the parent's value so the scope inherits again", async () => {
            const result = await reviewSettingsService.unset(
                { repository: 'kodus-ai' },
                'runOnDraft',
            );
            expect(configApi.saveCodeReviewConfig).toHaveBeenCalledWith(
                CTX.accessToken,
                expect.objectContaining({
                    configValue: { runOnDraft: true },
                    repositoryId: 'repo-1',
                }),
            );
            expect(result).toMatchObject({ changed: true, value: true });
        });

        it('does nothing when the scope does not set the key', async () => {
            const result = await reviewSettingsService.unset(
                { repository: 'kodus-ai' },
                'suggestionControl.severityLevelFilter',
            );
            expect(result.changed).toBe(false);
            expect(configApi.saveCodeReviewConfig).not.toHaveBeenCalled();
        });
    });

    describe('model', () => {
        const STATUS = {
            source: 'byok',
            byok: {
                configured: true,
                providerId: 'anthropic',
                model: 'model-a',
            },
            models: [
                { modelId: 'model-a', model: 'claude-a', resolvable: true },
                { modelId: 'model-b', model: 'claude-b', resolvable: false },
            ],
        };

        it('lists the configured models', async () => {
            configApi.getLLMConfigStatus.mockResolvedValue(STATUS);
            const result = await reviewSettingsService.listModels();
            expect(result).toEqual({
                byokConfigured: true,
                provider: 'anthropic',
                mainModel: 'model-a',
                models: [
                    { modelId: 'model-a', name: 'claude-a', resolvable: true },
                    { modelId: 'model-b', name: 'claude-b', resolvable: false },
                ],
            });
        });

        it('says when no BYOK provider is configured', async () => {
            configApi.getLLMConfigStatus.mockResolvedValue({
                source: 'env',
                byok: { configured: false },
                models: [],
            });
            await expect(reviewSettingsService.listModels()).resolves.toEqual({
                byokConfigured: false,
                models: [],
            });
            await expect(
                reviewSettingsService.setModel({ repository: 'global' }, 'x'),
            ).rejects.toThrow(/No BYOK provider/);
        });

        it('writes byokModelId at the scope, and an empty id to inherit', async () => {
            configApi.getLLMConfigStatus.mockResolvedValue(STATUS);
            await reviewSettingsService.setModel(
                { repository: 'kodus-ai', directory: 'apps/web' },
                'model-b',
            );
            expect(configApi.saveCodeReviewConfig).toHaveBeenLastCalledWith(
                CTX.accessToken,
                expect.objectContaining({
                    configValue: { byokModelId: 'model-b' },
                    directoryId: 'dir-1',
                }),
            );

            await reviewSettingsService.setModel(
                { repository: 'kodus-ai' },
                '',
            );
            expect(configApi.saveCodeReviewConfig).toHaveBeenLastCalledWith(
                CTX.accessToken,
                expect.objectContaining({ configValue: { byokModelId: '' } }),
            );
        });

        it("saves the model's id when given the provider's model name", async () => {
            configApi.getLLMConfigStatus.mockResolvedValue(STATUS);
            await reviewSettingsService.setModel(
                { repository: 'global' },
                'claude-b',
            );
            expect(configApi.saveCodeReviewConfig).toHaveBeenLastCalledWith(
                CTX.accessToken,
                expect.objectContaining({
                    configValue: { byokModelId: 'model-b' },
                }),
            );
        });

        it('refuses a model outside the configured list unless forced', async () => {
            configApi.getLLMConfigStatus.mockResolvedValue(STATUS);
            await expect(
                reviewSettingsService.setModel(
                    { repository: 'global' },
                    'gpt-x',
                ),
            ).rejects.toThrow(/--force/);

            await reviewSettingsService.setModel(
                { repository: 'global', force: true },
                'gpt-x',
            );
            expect(configApi.saveCodeReviewConfig).toHaveBeenCalledWith(
                CTX.accessToken,
                expect.objectContaining({
                    configValue: { byokModelId: 'gpt-x' },
                }),
            );
        });

        it("tests the provider's model name for a configured id", async () => {
            configApi.getLLMConfigStatus.mockResolvedValue(STATUS);
            configApi.testByokModel.mockResolvedValue({
                ok: true,
                code: 'ok',
                latencyMs: 120,
            });
            await reviewSettingsService.testModel('model-b');
            expect(configApi.testByokModel).toHaveBeenCalledWith(
                CTX.accessToken,
                { provider: 'anthropic', model: 'claude-b' },
            );
        });
    });
});

describe('readLeaf', () => {
    it('reads a field inside a key the default config lacks', () => {
        // The API formats suggestionControl.severityLimits as one leaf when
        // the default has no node for it.
        const configs = {
            suggestionControl: {
                severityLimits: {
                    value: { high: 2 },
                    level: 'repository',
                    overriddenValue: { high: 3 },
                    overriddenLevel: 'global',
                },
            },
        };

        expect(
            readLeaf(configs, 'suggestionControl.severityLimits.high'),
        ).toEqual({
            value: 2,
            level: 'repository',
            overriddenValue: 3,
            overriddenLevel: 'global',
        });
        expect(
            readLeaf(configs, 'suggestionControl.severityLimits.low'),
        ).toBeUndefined();
    });

    it('reads a regular leaf', () => {
        expect(
            readLeaf(
                {
                    summary: {
                        generatePRSummary: { value: false, level: 'directory' },
                    },
                },
                'summary.generatePRSummary',
            ),
        ).toEqual({ value: false, level: 'directory' });
    });
});
