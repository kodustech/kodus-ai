import { decrypt } from '@libs/common/utils/crypto';
import { CLI_SECRET_MASK } from '@libs/code-review/domain/custom-agents/cli-secrets';

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
                            directories: [],
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

    const save = async (configValue: Record<string, unknown>) => {
        await useCase.execute({
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
        return stored.repositories.find((repo: any) => repo.id === 'repo-1')
            .configs;
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
});
