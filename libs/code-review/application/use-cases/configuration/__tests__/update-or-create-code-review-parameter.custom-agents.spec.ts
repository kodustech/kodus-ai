import { decrypt } from '@libs/common/utils/crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';

import { CLI_SECRET_MASK } from '@libs/code-review/domain/custom-agents/cli-secrets';
import { customAgentsRevisionsAtLevel } from '@libs/code-review/domain/custom-agents/revision';

import { UpdateOrCreateCodeReviewParameterUseCase } from '../update-or-create-code-review-parameter-use-case';

const ledgerAgent = (secrets: Array<Record<string, string>>) => ({
    id: 'ledger-agent',
    name: 'Ledger reviewer',
    enabled: true,
    instructions: 'Every posting must balance debits and credits.',
    scope: { include: ['src/ledger/**'] },
    tools: {
        cli: [
            {
                name: 'ledgerctl',
                install: 'npm install -g @acme-ledger/ctl@1.2.3',
                binary: 'ledgerctl',
                allowedPrefixes: ['ledgerctl check'],
                usage: 'Run `ledgerctl check <path>`.',
                runsProjectCode: false,
                allowedDomains: ['ledger.example.test'],
                secrets,
            },
        ],
    },
    presentation: {
        tag: { color: '#304FFE' },
        format: 'inline',
        suggestedFix: 'when-confident',
    },
});

const buildUseCase = (
    repositoryConfigs: Record<string, unknown> = {},
    stored: {
        globalConfigs?: Record<string, unknown>;
        otherRepositoryConfigs?: Record<string, unknown>;
        directoryConfigs?: Record<string, unknown>;
    } = {},
) => {
    const createOrUpdateParametersUseCase = {
        execute: jest.fn().mockResolvedValue(true),
    };
    const eventEmitter = { emit: jest.fn() };
    const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
        {
            findByKey: jest.fn().mockResolvedValue({
                configValue: {
                    id: 'global',
                    name: 'Global',
                    isSelected: true,
                    configs: stored.globalConfigs ?? {},
                    repositories: [
                        {
                            id: 'repo-1',
                            name: 'ledger',
                            isSelected: true,
                            configs: repositoryConfigs,
                            directories: stored.directoryConfigs
                                ? [
                                      {
                                          id: 'dir-1',
                                          name: 'postings',
                                          isSelected: true,
                                          configs: stored.directoryConfigs,
                                          folders: [
                                              {
                                                  id: 'folder-1',
                                                  name: 'postings',
                                                  path: '/src/postings',
                                              },
                                          ],
                                      },
                                  ]
                                : [],
                        },
                        {
                            id: 'repo-2',
                            name: 'billing',
                            isSelected: true,
                            configs: stored.otherRepositoryConfigs ?? {},
                            directories: [],
                        },
                    ],
                },
            }),
        } as any,
        createOrUpdateParametersUseCase as any,
        {
            findIntegrationConfigFormatted: jest.fn().mockResolvedValue([
                { id: 'repo-1', name: 'ledger', directories: [] },
                { id: 'repo-2', name: 'billing', directories: [] },
            ]),
        } as any,
        eventEmitter as any,
        { ensure: jest.fn() } as any,
        { detectAndSaveReferences: jest.fn() } as any,
        { buildConfigKey: jest.fn().mockReturnValue('config-key') } as any,
        {
            getCentralizedRepositoryIfEnabled: jest
                .fn()
                .mockResolvedValue(null),
            getScopedKodusConfigFileContent: jest.fn().mockResolvedValue(null),
            createMutationPullRequestIfEnabled: jest
                .fn()
                .mockResolvedValue({ mode: 'direct' }),
        } as any,
        { find: jest.fn().mockResolvedValue([]) } as any,
        { getBYOKConfig: jest.fn(), getSubscriptionStatus: jest.fn() } as any,
        { execute: jest.fn().mockResolvedValue(undefined) } as any,
        {
            validateOrganizationLicense: jest.fn().mockResolvedValue({
                valid: true,
                subscriptionStatus: 'active',
                planType: 'teams_byok',
            }),
        } as any,
        { codeReviewSettingsUpdated: jest.fn() } as any,
    );

    const save = async (
        configValue: Record<string, unknown>,
        extra: Record<string, unknown> = {},
    ) => {
        await useCase.execute({
            ...extra,
            actor: {
                source: 'sync',
                organizationId: 'org-1',
                userId: 'kody',
                userEmail: 'kody@kodus.io',
            },
            configValue,
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-1',
            skipAuthorization: true,
        } as any);
        const stored = createOrUpdateParametersUseCase.execute.mock.calls[0][1];
        const repository = stored.repositories.find(
            (repo: any) => repo.id === 'repo-1',
        );
        return extra.directoryId
            ? repository.directories.find(
                  (dir: any) => dir.id === extra.directoryId,
              ).configs
            : repository.configs;
    };

    return { save, eventEmitter, useCase, createOrUpdateParametersUseCase };
};

describe('UpdateOrCreateCodeReviewParameterUseCase — custom agents', () => {
    it('persists custom agents and knowledge on the repository', async () => {
        const knowledge = [
            {
                path: 'docs/ledger.md',
                kind: 'doc',
                linkedTo: ['main-review', { agentId: 'ledger-agent' }],
            },
        ];
        const configs = await buildUseCase().save({
            customAgents: [ledgerAgent([])],
            knowledge,
        });

        expect(configs.customAgents).toHaveLength(1);
        expect(configs.customAgents[0].id).toBe('ledger-agent');
        expect(configs.knowledge).toEqual(knowledge);
    });

    it('stores a typed secret encrypted and never the plaintext', async () => {
        const configs = await buildUseCase().save({
            customAgents: [
                ledgerAgent([{ env: 'LEDGER_TOKEN', value: 'ledger-s3cret' }]),
            ],
        });

        const [secret] = configs.customAgents[0].tools.cli[0].secrets;
        expect(JSON.stringify(configs)).not.toContain('ledger-s3cret');
        expect(secret.env).toBe('LEDGER_TOKEN');
        expect(decrypt(secret.ciphertext)).toBe('ledger-s3cret');
    });

    it('keeps the stored ciphertext when the screen sends the mask back', async () => {
        const configs = await buildUseCase({
            customAgents: [
                ledgerAgent([{ env: 'LEDGER_TOKEN', ciphertext: 'iv:stored' }]),
            ],
        }).save({
            customAgents: [
                ledgerAgent([
                    { env: 'LEDGER_TOKEN', ciphertext: CLI_SECRET_MASK },
                ]),
            ],
        });

        expect(configs.customAgents[0].tools.cli[0].secrets).toEqual([
            { env: 'LEDGER_TOKEN', ciphertext: 'iv:stored' },
        ]);
    });

    it('never restores a secret stored on another repository or level', async () => {
        const storedElsewhere = {
            customAgents: [
                ledgerAgent([{ env: 'LEDGER_TOKEN', ciphertext: 'iv:other' }]),
            ],
        };
        const masked = {
            customAgents: [
                ledgerAgent([
                    { env: 'LEDGER_TOKEN', ciphertext: CLI_SECRET_MASK },
                ]),
            ],
        };

        await expect(
            buildUseCase({}, { globalConfigs: storedElsewhere }).save(masked),
        ).rejects.toThrow(/LEDGER_TOKEN/);
        await expect(
            buildUseCase({}, { otherRepositoryConfigs: storedElsewhere }).save(
                masked,
            ),
        ).rejects.toThrow(/LEDGER_TOKEN/);
    });

    it('encrypts a ciphertext it did not store instead of trusting it', async () => {
        const configs = await buildUseCase(
            {},
            {
                otherRepositoryConfigs: {
                    customAgents: [
                        ledgerAgent([
                            { env: 'LEDGER_TOKEN', ciphertext: 'iv:other' },
                        ]),
                    ],
                },
            },
        ).save({
            customAgents: [
                ledgerAgent([{ env: 'LEDGER_TOKEN', ciphertext: 'iv:other' }]),
            ],
        });

        const [secret] = configs.customAgents[0].tools.cli[0].secrets;
        expect(secret.ciphertext).not.toBe('iv:other');
        expect(decrypt(secret.ciphertext)).toBe('iv:other');
    });

    it('never writes a ciphertext into the settings audit log', async () => {
        const { save, eventEmitter } = buildUseCase({
            customAgents: [
                ledgerAgent([{ env: 'LEDGER_TOKEN', ciphertext: 'iv:stored' }]),
            ],
        });
        await save({
            customAgents: [
                ledgerAgent([{ env: 'LEDGER_TOKEN', value: 'ledger-s3cret' }]),
            ],
        });

        const audit = JSON.stringify(eventEmitter.emit.mock.calls);
        expect(eventEmitter.emit).toHaveBeenCalled();
        expect(audit).not.toContain('iv:stored');
        expect(audit).not.toContain('ledger-s3cret');
        expect(audit).not.toMatch(/"ciphertext":"(?!••••)[^"]+"/);
    });

    it('logs a failed save without the submitted configuration', async () => {
        const { save, useCase, createOrUpdateParametersUseCase } =
            buildUseCase();
        createOrUpdateParametersUseCase.execute.mockRejectedValueOnce(
            new Error('write failed'),
        );
        const errorLog = jest
            .spyOn((useCase as any).logger, 'error')
            .mockImplementation(() => undefined);

        await expect(
            save({
                customAgents: [ledgerAgent([])],
                summary: { customInstructions: 'Internal ledger notes' },
            }),
        ).rejects.toThrow();

        const logged = JSON.stringify(errorLog.mock.calls);
        expect(logged).not.toContain('Every posting must balance');
        expect(logged).not.toContain('Internal ledger notes');
        expect(logged).toContain('customAgents');
    });

    describe('knowledge links', () => {
        const auditAgent = {
            ...ledgerAgent([]),
            id: 'audit-agent',
            name: 'Audit reviewer',
        };
        const linkedTo = (agentId: string) => [
            { path: 'docs/postings.md', kind: 'doc', linkedTo: [{ agentId }] },
        ];

        it('refuses a link to an agent the repository does not configure', async () => {
            const { save, createOrUpdateParametersUseCase } = buildUseCase();

            const attempt = save({
                customAgents: [ledgerAgent([])],
                knowledge: linkedTo('agent-missing'),
            });

            await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
            await expect(attempt).rejects.toThrow(
                'docs/postings.md links to unknown agent "agent-missing"',
            );
            expect(
                createOrUpdateParametersUseCase.execute,
            ).not.toHaveBeenCalled();
        });

        it("lets a directory link a skill or doc to the repository's agent", async () => {
            // The directory runs the repository's agents too, so its own
            // knowledge may name one of them.
            const configs = await buildUseCase(
                { customAgents: [ledgerAgent([])] },
                { directoryConfigs: {} },
            ).save(
                {
                    customAgents: [auditAgent],
                    knowledge: linkedTo('ledger-agent'),
                },
                { directoryId: 'dir-1' },
            );

            expect(configs.knowledge).toEqual(linkedTo('ledger-agent'));
        });

        it('refuses a directory link to an agent that exists on neither level', async () => {
            const attempt = buildUseCase(
                { customAgents: [ledgerAgent([])] },
                {
                    directoryConfigs: {},
                    otherRepositoryConfigs: { customAgents: [auditAgent] },
                },
            ).save(
                { customAgents: [], knowledge: linkedTo('audit-agent') },
                { directoryId: 'dir-1' },
            );

            await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('a save made from a stale copy of the lists', () => {
        const loadedFrom = (repositoryConfigs: Record<string, unknown>) =>
            customAgentsRevisionsAtLevel(
                {
                    configs: {},
                    repositories: [
                        { id: 'repo-1', configs: repositoryConfigs },
                    ],
                },
                { repositoryId: 'repo-1' },
            );
        const auditAgent = {
            ...ledgerAgent([]),
            id: 'audit-agent',
            name: 'Audit reviewer',
        };

        it('is rejected with a conflict and writes nothing', async () => {
            // This tab loaded one agent; another tab saved a second since.
            const loaded = loadedFrom({ customAgents: [ledgerAgent([])] });
            const { save, createOrUpdateParametersUseCase } = buildUseCase({
                customAgents: [ledgerAgent([]), auditAgent],
            });

            const attempt = save(
                {
                    customAgents: [
                        { ...ledgerAgent([]), instructions: 'Edited here.' },
                    ],
                },
                { expectedRevisions: loaded },
            );

            await expect(attempt).rejects.toBeInstanceOf(ConflictException);
            await expect(attempt).rejects.toThrow(/Reload/);
            expect(
                createOrUpdateParametersUseCase.execute,
            ).not.toHaveBeenCalled();
        });

        it('is saved when the lists did not change since they were loaded', async () => {
            const stored = { customAgents: [ledgerAgent([])], knowledge: [] };
            const configs = await buildUseCase(stored).save(
                { customAgents: [ledgerAgent([]), auditAgent] },
                { expectedRevisions: loadedFrom(stored) },
            );

            expect(configs.customAgents.map((a: any) => a.id)).toEqual([
                'ledger-agent',
                'audit-agent',
            ]);
        });

        it('does not block other settings saved with a stale revision', async () => {
            const loaded = loadedFrom({ customAgents: [ledgerAgent([])] });
            const configs = await buildUseCase({
                customAgents: [ledgerAgent([]), auditAgent],
            }).save(
                { automatedReviewActive: false },
                { expectedRevisions: loaded },
            );

            expect(configs.automatedReviewActive).toBe(false);
        });
    });
});
