import {
    BadRequestException,
    ForbiddenException,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';

import { decrypt } from '@libs/common/utils/crypto';
import { CLI_SECRET_MASK } from '@libs/code-review/domain/custom-agents/cli-secrets';
import { CUSTOM_AGENTS_PLAN_REQUIRED } from '@libs/code-review/infrastructure/agents/custom-agents/custom-agents-plan';

import {
    GetCustomAgentsStatusUseCase,
    summarizeCustomAgentSuggestions,
} from './get-custom-agents-status.use-case';
import { ResolveCustomAgentUseCase } from './resolve-custom-agent.use-case';
import { TryCustomAgentUseCase } from './try-custom-agent.use-case';

const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };

const ledgerAgent = (overrides: Record<string, unknown> = {}) => ({
    id: 'ledger-agent',
    name: 'Ledger reviewer',
    enabled: true,
    instructions: 'Every posting must balance debits and credits.',
    scope: { include: ['src/ledger/**'] },
    tools: {},
    presentation: {
        tag: { color: '#304FFE' },
        format: 'inline',
        suggestedFix: 'when-confident',
    },
    ...overrides,
});

const TEAMS = {
    valid: true,
    subscriptionStatus: 'active',
    planType: 'teams_byok',
};
const licenseService = (license: unknown) => ({
    validateOrganizationLicense: jest.fn().mockResolvedValue(license),
});

const parametersService = (configValue: Record<string, unknown>) => ({
    findByKey: jest.fn().mockResolvedValue({ configValue }),
});

const storedConfig = (repositoryConfigs: Record<string, unknown> = {}) => ({
    configs: {},
    repositories: [
        {
            id: 'repo-1',
            name: 'ledger',
            configs: repositoryConfigs,
            directories: [],
        },
    ],
});

describe('ResolveCustomAgentUseCase', () => {
    const codeManagementService = {
        getDefaultBranch: jest.fn().mockResolvedValue('main'),
    };

    it('checks the knowledge against the default branch and flags Kody Rules sources', async () => {
        const knowledgeReader = {
            resolve: jest.fn().mockResolvedValue([
                {
                    path: 'docs/ledger.md',
                    kind: 'doc',
                    found: true,
                    issues: [],
                    tokens: 1200,
                },
            ]),
            discover: jest
                .fn()
                .mockResolvedValue([{ path: 'AGENTS.md', kind: 'doc' }]),
        };
        const useCase = new ResolveCustomAgentUseCase(
            parametersService(storedConfig()) as any,
            codeManagementService as any,
            knowledgeReader,
        );

        const report = await useCase.execute({
            organizationAndTeamData,
            repositoryId: 'repo-1',
            agent: ledgerAgent({
                tools: {
                    astGrepConfig:
                        'id: no-float-money\nlanguage: ts\nrule: { pattern: parseFloat($A) }',
                },
            }),
            knowledge: [
                {
                    path: 'docs/ledger.md',
                    kind: 'doc',
                    linkedTo: [{ agentId: 'ledger-agent' }],
                },
                {
                    path: 'CLAUDE.md',
                    kind: 'doc',
                    linkedTo: ['main-review'],
                },
            ],
            discover: true,
        });

        expect(knowledgeReader.resolve).toHaveBeenCalledWith(
            expect.objectContaining({
                repository: { id: 'repo-1', name: 'ledger', branch: 'main' },
            }),
        );
        expect(report.agentIssues).toEqual([]);
        expect(report.astGrep.ruleCount).toBe(1);
        expect(report.mcp).toEqual({
            status: 'unavailable',
            reason: expect.any(String),
        });
        if (report.knowledge.status !== 'ok') throw new Error('expected ok');
        expect(
            report.knowledge.items.map((item) => [
                item.path,
                item.found,
                item.kodyRuleSource,
            ]),
        ).toEqual([
            ['docs/ledger.md', true, false],
            ['CLAUDE.md', false, true],
        ]);
        expect(report.knowledge.budgets).toContainEqual(
            expect.objectContaining({
                target: 'agent:ledger-agent',
                docTokens: 1200,
            }),
        );
        expect(report.knowledge.candidates).toEqual([
            { path: 'AGENTS.md', kind: 'doc', kodyRuleSource: true },
        ]);
    });

    describe('ast-grep rule file path', () => {
        const agentWithPath = ledgerAgent({
            tools: { astGrepConfig: 'rules/ledger.yml' },
        });

        it('reads the rule file from the branch and counts its rules', async () => {
            const knowledgeReader = {
                resolve: jest.fn(),
                discover: jest.fn(),
                readFile: jest
                    .fn()
                    .mockResolvedValue(
                        'id: no-float-money\nlanguage: ts\nrule: { pattern: parseFloat($A) }',
                    ),
            };
            const useCase = new ResolveCustomAgentUseCase(
                parametersService(storedConfig()) as any,
                codeManagementService as any,
                knowledgeReader,
            );

            const report = await useCase.execute({
                organizationAndTeamData,
                repositoryId: 'repo-1',
                agent: agentWithPath,
            });

            expect(knowledgeReader.readFile).toHaveBeenCalledWith(
                expect.objectContaining({
                    repository: { id: 'repo-1', name: 'ledger', branch: 'main' },
                    path: 'rules/ledger.yml',
                }),
            );
            expect(report.astGrep).toEqual({
                ruleCount: 1,
                ruleIds: ['no-float-money'],
                errors: [],
                rulesPath: 'rules/ledger.yml',
            });
        });

        it('reports a rule file missing on the branch', async () => {
            const knowledgeReader = {
                resolve: jest.fn(),
                discover: jest.fn(),
                readFile: jest.fn().mockResolvedValue(null),
            };
            const useCase = new ResolveCustomAgentUseCase(
                parametersService(storedConfig()) as any,
                codeManagementService as any,
                knowledgeReader,
            );

            const report = await useCase.execute({
                organizationAndTeamData,
                repositoryId: 'repo-1',
                agent: agentWithPath,
            });

            expect(report.astGrep.ruleCount).toBe(0);
            expect(report.astGrep.errors).toEqual([
                'Rule file rules/ledger.yml was not found on main.',
            ]);
        });

        it('at the global level leaves the rule file to each repository', async () => {
            const knowledgeReader = {
                resolve: jest.fn(),
                discover: jest.fn(),
                readFile: jest.fn(),
            };
            const useCase = new ResolveCustomAgentUseCase(
                parametersService(storedConfig()) as any,
                codeManagementService as any,
                knowledgeReader,
            );

            const report = await useCase.execute({
                organizationAndTeamData,
                repositoryId: 'global',
                agent: agentWithPath,
            });

            expect(knowledgeReader.readFile).not.toHaveBeenCalled();
            expect(report.astGrep).toEqual({
                ruleCount: 0,
                ruleIds: [],
                errors: [],
                rulesPath: 'rules/ledger.yml',
            });
        });
    });

    it('reports schema problems of the draft, accepting typed secrets', async () => {
        const useCase = new ResolveCustomAgentUseCase(
            parametersService(storedConfig()) as any,
            codeManagementService as any,
        );

        const report = await useCase.execute({
            organizationAndTeamData,
            repositoryId: 'repo-1',
            agent: ledgerAgent({
                instructions: 'x'.repeat(8001),
                tools: {
                    cli: [
                        {
                            name: 'ledgerctl',
                            install: 'npm install -g @acme-ledger/ctl@1.2.3',
                            binary: 'ledgerctl',
                            allowedPrefixes: ['ledgerctl check'],
                            usage: '',
                            runsProjectCode: false,
                            allowedDomains: [],
                            secrets: [{ env: 'LEDGER_TOKEN', value: 'typed' }],
                        },
                    ],
                },
            }),
        });

        expect(report.agentIssues).toHaveLength(1);
        expect(report.agentIssues[0]).toMatch(/^instructions:/);
        expect(report.knowledge.status).toBe('unavailable');
    });

    it('at the global level lists the plugins and leaves skills and docs to each repository', async () => {
        const knowledgeReader = { resolve: jest.fn(), discover: jest.fn() };
        const toolCatalog = {
            listReadOnlyMcpTools: jest
                .fn()
                .mockResolvedValue([
                    { integrationId: 'linear', name: 'Linear', tools: [] },
                ]),
        };
        const useCase = new ResolveCustomAgentUseCase(
            parametersService(storedConfig()) as any,
            codeManagementService as any,
            knowledgeReader,
            toolCatalog as any,
        );

        const report = await useCase.execute({
            organizationAndTeamData,
            repositoryId: 'global',
            agent: ledgerAgent(),
            knowledge: [{ path: 'docs/ledger.md', kind: 'doc', linkedTo: [] }],
            discover: true,
        });

        expect(report.mcp).toMatchObject({
            status: 'ok',
            integrations: [{ name: 'Linear' }],
        });
        expect(report.knowledge).toMatchObject({ status: 'unavailable' });
        expect(knowledgeReader.resolve).not.toHaveBeenCalled();
        expect(report.repository).toBeUndefined();
    });

    it('refuses a repository the team does not have', async () => {
        const useCase = new ResolveCustomAgentUseCase(
            parametersService(storedConfig()) as any,
            codeManagementService as any,
        );

        await expect(
            useCase.execute({
                organizationAndTeamData,
                repositoryId: 'repo-unknown',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('TryCustomAgentUseCase', () => {
    const trace = {
        status: 'completed',
        skillsOpened: [],
        toolCalls: [],
        findings: [],
    };

    it('runs the draft with sealed secrets and only its own knowledge', async () => {
        const runner = {
            runCustomAgentOnPullRequest: jest.fn().mockResolvedValue(trace),
        };
        const useCase = new TryCustomAgentUseCase(
            parametersService(
                storedConfig({
                    customAgents: [
                        ledgerAgent({
                            tools: {
                                cli: [
                                    {
                                        name: 'ledgerctl',
                                        secrets: [
                                            {
                                                env: 'LEDGER_URL',
                                                ciphertext: 'iv:stored',
                                            },
                                        ],
                                    },
                                ],
                            },
                        }),
                    ],
                }),
            ) as any,
            licenseService(TEAMS) as any,
            runner,
        );
        const cli = {
            name: 'ledgerctl',
            install: 'npm install -g @acme-ledger/ctl@1.2.3',
            binary: 'ledgerctl',
            allowedPrefixes: ['ledgerctl check'],
            usage: '',
            runsProjectCode: false,
            allowedDomains: [],
            secrets: [
                { env: 'LEDGER_TOKEN', value: 'typed-token' },
                { env: 'LEDGER_URL', ciphertext: CLI_SECRET_MASK },
            ],
        };

        const result = await useCase.execute({
            organizationAndTeamData,
            repositoryId: 'repo-1',
            prUrl: 'https://git.example.test/ledger/pull/7',
            agent: ledgerAgent({ tools: { cli: [cli] } }),
            knowledge: [
                {
                    path: 'docs/ledger.md',
                    kind: 'doc',
                    linkedTo: [{ agentId: 'ledger-agent' }],
                },
                {
                    path: 'docs/other.md',
                    kind: 'doc',
                    linkedTo: ['main-review'],
                },
            ],
        });

        expect(result).toBe(trace);
        const call = runner.runCustomAgentOnPullRequest.mock.calls[0][0];
        const secrets = call.agent.tools.cli[0].secrets;
        expect(JSON.stringify(call)).not.toContain('typed-token');
        expect(decrypt(secrets[0].ciphertext)).toBe('typed-token');
        expect(secrets[1]).toEqual({
            env: 'LEDGER_URL',
            ciphertext: 'iv:stored',
        });
        expect(call.knowledge.map((item: any) => item.path)).toEqual([
            'docs/ledger.md',
        ]);
    });

    it('never borrows a secret stored for another repository', async () => {
        const runner = { runCustomAgentOnPullRequest: jest.fn() };
        const withSecret = {
            customAgents: [
                ledgerAgent({
                    tools: {
                        cli: [
                            {
                                name: 'ledgerctl',
                                secrets: [
                                    {
                                        env: 'LEDGER_URL',
                                        ciphertext: 'iv:other',
                                    },
                                ],
                            },
                        ],
                    },
                }),
            ],
        };
        const config = storedConfig({});
        config.repositories.push({
            id: 'repo-2',
            name: 'billing',
            configs: withSecret,
            directories: [],
        });
        const useCase = new TryCustomAgentUseCase(
            parametersService(config) as any,
            licenseService(TEAMS) as any,
            runner,
        );
        const cli = {
            name: 'ledgerctl',
            install: 'npm install -g @acme-ledger/ctl@1.2.3',
            binary: 'ledgerctl',
            allowedPrefixes: ['ledgerctl check'],
            usage: '',
            runsProjectCode: false,
            allowedDomains: [],
            secrets: [{ env: 'LEDGER_URL', ciphertext: CLI_SECRET_MASK }],
        };

        await expect(
            useCase.execute({
                organizationAndTeamData,
                repositoryId: 'repo-1',
                prUrl: 'https://git.example.test/ledger/pull/7',
                agent: ledgerAgent({ tools: { cli: [cli] } }),
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(runner.runCustomAgentOnPullRequest).not.toHaveBeenCalled();
    });

    it('uses the secret of an agent the repository inherits from global', async () => {
        const runner = {
            runCustomAgentOnPullRequest: jest.fn().mockResolvedValue(trace),
        };
        const config = storedConfig({});
        (config as any).configs = {
            customAgents: [
                ledgerAgent({
                    tools: {
                        cli: [
                            {
                                name: 'ledgerctl',
                                secrets: [
                                    {
                                        env: 'LEDGER_URL',
                                        ciphertext: 'iv:global',
                                    },
                                ],
                            },
                        ],
                    },
                }),
            ],
        };
        const useCase = new TryCustomAgentUseCase(
            parametersService(config) as any,
            licenseService(TEAMS) as any,
            runner,
        );

        await useCase.execute({
            organizationAndTeamData,
            repositoryId: 'repo-1',
            prUrl: 'https://git.example.test/ledger/pull/7',
            agent: ledgerAgent({
                tools: {
                    cli: [
                        {
                            name: 'ledgerctl',
                            install: 'npm install -g @acme-ledger/ctl@1.2.3',
                            binary: 'ledgerctl',
                            allowedPrefixes: ['ledgerctl check'],
                            usage: '',
                            runsProjectCode: false,
                            allowedDomains: [],
                            secrets: [
                                {
                                    env: 'LEDGER_URL',
                                    ciphertext: CLI_SECRET_MASK,
                                },
                            ],
                        },
                    ],
                },
            }),
        });

        const call = runner.runCustomAgentOnPullRequest.mock.calls[0][0];
        expect(call.agent.tools.cli[0].secrets[0].ciphertext).toBe('iv:global');
    });

    it('rejects an invalid draft before running anything', async () => {
        const runner = { runCustomAgentOnPullRequest: jest.fn() };
        const useCase = new TryCustomAgentUseCase(
            parametersService(storedConfig()) as any,
            licenseService(TEAMS) as any,
            runner,
        );

        await expect(
            useCase.execute({
                organizationAndTeamData,
                repositoryId: 'repo-1',
                prUrl: 'https://git.example.test/ledger/pull/7',
                agent: ledgerAgent({ presentation: { mode: 'loud' } }),
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(runner.runCustomAgentOnPullRequest).not.toHaveBeenCalled();
    });

    it('says so when no runner is bound', async () => {
        const useCase = new TryCustomAgentUseCase(
            parametersService(storedConfig()) as any,
            licenseService(TEAMS) as any,
        );

        await expect(
            useCase.execute({
                organizationAndTeamData,
                repositoryId: 'repo-1',
                prUrl: 'https://git.example.test/ledger/pull/7',
                agent: ledgerAgent(),
            }),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it.each([
        [
            'free',
            {
                valid: true,
                subscriptionStatus: 'active',
                planType: 'free_byok',
            },
        ],
        ['an unreadable license', new Error('billing down')],
    ])('refuses on %s without running the agent', async (_, license) => {
        const runner = { runCustomAgentOnPullRequest: jest.fn() };
        const useCase = new TryCustomAgentUseCase(
            parametersService(storedConfig()) as any,
            {
                validateOrganizationLicense:
                    license instanceof Error
                        ? jest.fn().mockRejectedValue(license)
                        : jest.fn().mockResolvedValue(license),
            } as any,
            runner,
        );

        const run = useCase.execute({
            organizationAndTeamData,
            repositoryId: 'repo-1',
            prUrl: 'https://git.example.test/ledger/pull/7',
            agent: ledgerAgent(),
        });

        await expect(run).rejects.toBeInstanceOf(ForbiddenException);
        await expect(run).rejects.toThrow(CUSTOM_AGENTS_PLAN_REQUIRED);
        expect(runner.runCustomAgentOnPullRequest).not.toHaveBeenCalled();
    });

    it('runs on a trial', async () => {
        const runner = {
            runCustomAgentOnPullRequest: jest.fn().mockResolvedValue(trace),
        };
        const useCase = new TryCustomAgentUseCase(
            parametersService(storedConfig()) as any,
            licenseService({
                valid: true,
                subscriptionStatus: 'trial',
                planType: 'teams_managed',
            }) as any,
            runner,
        );

        await expect(
            useCase.execute({
                organizationAndTeamData,
                repositoryId: 'repo-1',
                prUrl: 'https://git.example.test/ledger/pull/7',
                agent: ledgerAgent(),
            }),
        ).resolves.toEqual(trace);
    });
});

describe('GetCustomAgentsStatusUseCase', () => {
    it('counts pull requests, posted and dropped findings per agent', () => {
        expect(
            summarizeCustomAgentSuggestions([
                {
                    agentId: 'ledger-agent',
                    prNumber: 7,
                    deliveryStatus: 'sent',
                    priorityStatus: 'prioritized',
                },
                {
                    agentId: 'ledger-agent',
                    prNumber: 7,
                    deliveryStatus: 'not_sent',
                    priorityStatus: 'prioritized',
                },
                {
                    agentId: 'ledger-agent',
                    prNumber: 9,
                    deliveryStatus: 'not_sent',
                    priorityStatus: 'discarded-by-safeguard',
                },
                {
                    agentId: 'e2e-agent',
                    prNumber: 9,
                    deliveryStatus: 'not_sent',
                    priorityStatus: 'prioritized',
                },
            ]),
        ).toEqual([
            {
                agentId: 'ledger-agent',
                pullRequests: 2,
                posted: 1,
                dropped: 1,
            },
            {
                agentId: 'e2e-agent',
                pullRequests: 1,
                posted: 0,
                dropped: 0,
            },
        ]);
    });

    it('weights each grouped row by its finding count', () => {
        expect(
            summarizeCustomAgentSuggestions([
                {
                    agentId: 'ledger-agent',
                    prNumber: 7,
                    deliveryStatus: 'sent',
                    count: 3,
                },
                {
                    agentId: 'ledger-agent',
                    prNumber: 7,
                    priorityStatus: 'discarded-by-safeguard',
                    count: 2,
                },
            ]),
        ).toEqual([
            {
                agentId: 'ledger-agent',
                pullRequests: 1,
                posted: 3,
                dropped: 2,
            },
        ]);
    });

    it('reads file and PR-level findings of the repository over 30 days', async () => {
        const aggregate = jest
            .fn()
            .mockReturnValueOnce({
                toArray: async () => [
                    {
                        agentId: 'ledger-agent',
                        prNumber: 7,
                        deliveryStatus: 'sent',
                    },
                ],
            })
            .mockReturnValueOnce({
                toArray: async () => [
                    {
                        agentId: 'ledger-agent',
                        prNumber: 8,
                        deliveryStatus: 'sent',
                    },
                ],
            });
        const useCase = new GetCustomAgentsStatusUseCase({
            getNativeCollection: () => ({ aggregate }),
        } as any);

        const result = await useCase.execute({
            organizationId: 'org-1',
            repositoryId: 'repo-1',
            now: new Date('2026-10-17T00:00:00Z'),
        });

        expect(result.windowDays).toBe(30);
        expect(result.agents).toEqual([
            {
                agentId: 'ledger-agent',
                pullRequests: 2,
                posted: 2,
                dropped: 0,
            },
        ]);
        // Mongo groups the findings per agent, PR and status, so the rows
        // read into memory are bounded by those, not by finding volume.
        const pipeline = aggregate.mock.calls[0][0];
        expect(pipeline.find((stage) => stage.$group)).toEqual({
            $group: expect.objectContaining({
                _id: {
                    agentId: expect.any(String),
                    prNumber: expect.any(String),
                    deliveryStatus: expect.any(String),
                    priorityStatus: expect.any(String),
                },
                count: { $sum: 1 },
            }),
        });
        expect(aggregate.mock.calls[0][1]).toEqual({ allowDiskUse: true });
        const [firstMatch] = aggregate.mock.calls[0][0];
        expect(firstMatch.$match).toEqual({
            'organizationId': 'org-1',
            'repository.id': 'repo-1',
            'updatedAt': { $gte: new Date('2026-09-17T00:00:00Z') },
            'files.suggestions.customAgent.id': { $exists: true },
        });
    });
});
