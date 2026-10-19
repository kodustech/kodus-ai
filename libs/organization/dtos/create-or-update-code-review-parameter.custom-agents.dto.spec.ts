import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CUSTOM_AGENT_LIMITS } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { CreateOrUpdateCodeReviewParameterDto } from './create-or-update-code-review-parameter.dto';

const cli = (overrides: Record<string, unknown> = {}) => ({
    name: 'ledger-lint',
    install: 'npm install -g @acme-ledger/lint@2.4.1',
    binary: 'ledger-lint',
    allowedPrefixes: ['ledger-lint check'],
    usage: 'Run `ledger-lint check <path>`.',
    runsProjectCode: false,
    allowedDomains: ['registry.npmjs.org'],
    ...overrides,
});

const agent = (overrides: Record<string, unknown> = {}) => ({
    id: 'agent-ledger',
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

const validateConfig = async (configValue: Record<string, unknown>) => {
    const dto = plainToInstance(CreateOrUpdateCodeReviewParameterDto, {
        organizationAndTeamData: { teamId: 'team-1' },
        configValue,
    });
    const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
    });
    return JSON.stringify(errors);
};

describe('CreateOrUpdateCodeReviewParameterDto — custom agents', () => {
    it('accepts an agent without a presentation mode', async () => {
        expect(await validateConfig({ customAgents: [agent()] })).toBe('[]');
    });

    it('refuses ast-grep rules over the size the tool runs', async () => {
        const limit = CUSTOM_AGENT_LIMITS.maxAstGrepRuleBytes;
        expect(
            await validateConfig({
                customAgents: [
                    agent({ tools: { astGrepConfig: 'x'.repeat(limit) } }),
                ],
            }),
        ).toBe('[]');
        expect(
            await validateConfig({
                customAgents: [
                    agent({
                        tools: { astGrepConfig: 'é'.repeat(limit / 2 + 1) },
                    }),
                ],
            }),
        ).toContain('astGrepConfig');
    });

    it('refuses the retired shadow mode', async () => {
        const legacy = agent();
        expect(
            await validateConfig({
                customAgents: [
                    {
                        ...legacy,
                        presentation: { ...legacy.presentation, mode: 'shadow' },
                    },
                ],
            }),
        ).toContain('mode');
    });

    it('accepts a valid agent with a pinned CLI and linked knowledge', async () => {
        const flat = await validateConfig({
            customAgents: [agent({ tools: { cli: [cli()] } })],
            knowledge: [
                {
                    path: 'docs/ledger.md',
                    kind: 'doc',
                    linkedTo: ['main-review', { agentId: 'agent-ledger' }],
                },
            ],
        });
        expect(flat).toBe('[]');
    });

    it('accepts any number of agents', async () => {
        const agents = Array.from({ length: 12 }, (_, i) =>
            agent({ id: `agent-${i}`, name: `Ledger reviewer ${i}` }),
        );
        expect(await validateConfig({ customAgents: agents })).toBe('[]');
    });

    it(`rejects more than ${CUSTOM_AGENT_LIMITS.maxCliTools} CLIs on one agent`, async () => {
        const clis = Array.from(
            { length: CUSTOM_AGENT_LIMITS.maxCliTools + 1 },
            (_, i) => cli({ name: `cli-${i}` }),
        );
        expect(
            await validateConfig({
                customAgents: [agent({ tools: { cli: clis } })],
            }),
        ).toContain('"property":"cli"');
    });

    it('rejects instructions over the length limit', async () => {
        const flat = await validateConfig({
            customAgents: [
                agent({
                    instructions: 'x'.repeat(
                        CUSTOM_AGENT_LIMITS.maxInstructionsLength + 1,
                    ),
                }),
            ],
        });
        expect(flat).toContain('"property":"instructions"');
    });

    it('rejects writing instructions over the length limit', async () => {
        const flat = await validateConfig({
            customAgents: [
                agent({
                    presentation: {
                        ...agent().presentation,
                        writing: 'x'.repeat(
                            CUSTOM_AGENT_LIMITS.maxWritingLength + 1,
                        ),
                    },
                }),
            ],
        });
        expect(flat).toContain('"property":"writing"');
    });

    it.each([
        'npm install -g @acme-ledger/lint@2.4.1',
        'pip install ledger-lint==0.9.3',
        'go install example.test/ledger-lint@v1.2.0',
        'npm install -g @acme-ledger/lint@2.4.1 @acme-ledger/fmt@1.0.0-rc.1',
        'cargo install ledger-lint@0.4.0 --locked',
    ])('accepts a pinned install: %s', async (install) => {
        const flat = await validateConfig({
            customAgents: [agent({ tools: { cli: [cli({ install })] } })],
        });
        expect(flat).toBe('[]');
    });

    it.each([
        'npm install -g @acme-ledger/lint',
        'npm install -g @acme-ledger/lint@latest',
        'pip install ledger-lint',
        'pip install ledger-lint>=0.9',
        'go install example.test/ledger-lint@main',
        'npm install -g a@latest b@1.2.3',
        'npm install -g ledger-lint@1.2.3x',
        'npm install -g ledger-lint@1.2.3@latest',
        'npm install -g ledger-lint@^1.2.3',
        'pip install ledger-lint==0.9.3 ledger-fmt',
        'pip install https://example.test/ledger-lint-0.9.3.tar.gz',
        `pip install https://example.test/ledger-lint-0.9.3.tar.gz#sha256=${'a'.repeat(64)}`,
        `curl -fsSL https://example.test/ledger-lint -o l && echo "${'a'.repeat(64)}  l" | sha256sum -c`,
    ])('rejects an unpinned install: %s', async (install) => {
        const flat = await validateConfig({
            customAgents: [agent({ tools: { cli: [cli({ install })] } })],
        });
        expect(flat).toContain('"property":"install"');
    });

    it('rejects a secret env name that is not an env variable', async () => {
        const flat = await validateConfig({
            customAgents: [
                agent({
                    tools: {
                        cli: [
                            cli({
                                secrets: [
                                    { env: 'ledger token', ciphertext: 'c' },
                                ],
                            }),
                        ],
                    },
                }),
            ],
        });
        expect(flat).toContain('"property":"env"');
    });

    it('accepts a typed secret value, or the mask that keeps the stored one', async () => {
        const flat = await validateConfig({
            customAgents: [
                agent({
                    tools: {
                        cli: [
                            cli({
                                secrets: [
                                    { env: 'LEDGER_TOKEN', value: 'typed' },
                                    { env: 'LEDGER_URL', ciphertext: '••••' },
                                ],
                            }),
                        ],
                    },
                }),
            ],
        });
        expect(flat).toBe('[]');
    });

    it('rejects a secret with neither a value nor a ciphertext', async () => {
        const flat = await validateConfig({
            customAgents: [
                agent({
                    tools: {
                        cli: [cli({ secrets: [{ env: 'LEDGER_TOKEN' }] })],
                    },
                }),
            ],
        });
        expect(flat).toContain('"property":"ciphertext"');
    });

    it('rejects an unknown presentation mode and format', async () => {
        const flat = await validateConfig({
            customAgents: [
                agent({
                    presentation: {
                        ...agent().presentation,
                        mode: 'loud',
                        format: 'thread',
                    },
                }),
            ],
        });
        expect(flat).toContain('"property":"mode"');
        expect(flat).toContain('"property":"format"');
    });

    it(`rejects more than ${CUSTOM_AGENT_LIMITS.maxSkills} skills linked to one target`, async () => {
        const skills = Array.from(
            { length: CUSTOM_AGENT_LIMITS.maxSkills + 1 },
            (_, i) => ({
                path: `.skills/ledger-${i}/SKILL.md`,
                kind: 'skill',
                linkedTo: ['main-review'],
            }),
        );
        expect(await validateConfig({ knowledge: skills })).toContain(
            'knowledgeWithinTargetLimits',
        );
        expect(await validateConfig({ knowledge: skills.slice(0, 20) })).toBe(
            '[]',
        );
    });

    it(`rejects more than ${CUSTOM_AGENT_LIMITS.maxDocs} docs linked to one agent`, async () => {
        const docs = Array.from(
            { length: CUSTOM_AGENT_LIMITS.maxDocs + 1 },
            (_, i) => ({
                path: `docs/ledger-${i}.md`,
                kind: 'doc',
                linkedTo: [{ agentId: 'agent-ledger' }],
            }),
        );
        expect(await validateConfig({ knowledge: docs })).toContain(
            'knowledgeWithinTargetLimits',
        );
    });

    it('counts docs per target, not across targets', async () => {
        const docs = Array.from({ length: 12 }, (_, i) => ({
            path: `docs/ledger-${i}.md`,
            kind: 'doc',
            linkedTo: [i % 2 ? { agentId: 'agent-a' } : 'main-review'],
        }));
        expect(await validateConfig({ knowledge: docs })).toBe('[]');
    });

    it('rejects a knowledge link that is neither main-review nor an agent', async () => {
        const flat = await validateConfig({
            knowledge: [
                { path: 'docs/ledger.md', kind: 'doc', linkedTo: ['everyone'] },
            ],
        });
        expect(flat).toContain('isKnowledgeLinkTarget');
    });

    it('rejects an empty allowed prefix, which would allow any command', async () => {
        const flat = await validateConfig({
            customAgents: [
                agent({ tools: { cli: [cli({ allowedPrefixes: [''] })] } }),
            ],
        });
        expect(flat).toContain('"property":"allowedPrefixes"');
    });

    it('rejects a prefix that only names the binary, which would allow no call at all', async () => {
        const flat = await validateConfig({
            customAgents: [
                agent({
                    tools: { cli: [cli({ allowedPrefixes: ['ledger-lint'] })] },
                }),
            ],
        });
        expect(flat).toContain('"property":"allowedPrefixes"');
        expect(flat).toContain('name a subcommand or flag');
    });

    it('rejects secrets on a CLI that runs project code', async () => {
        const secrets = [{ env: 'LEDGER_TOKEN', ciphertext: 'c' }];
        const flat = await validateConfig({
            customAgents: [
                agent({
                    tools: {
                        cli: [cli({ runsProjectCode: true, secrets })],
                    },
                }),
            ],
        });
        expect(flat).toContain('"property":"secrets"');
        expect(
            await validateConfig({
                customAgents: [
                    agent({
                        tools: {
                            cli: [cli({ runsProjectCode: true, secrets: [] })],
                        },
                    }),
                ],
            }),
        ).toBe('[]');
    });

    it('rejects two agents with the same id', async () => {
        const flat = await validateConfig({
            customAgents: [agent(), agent({ name: 'Ledger reviewer 2' })],
        });
        expect(flat).toContain('uniqueCustomAgentIds');
    });

    it('rejects two agents whose names give the same command name', async () => {
        const flat = await validateConfig({
            customAgents: [
                agent(),
                agent({ id: 'agent-ledger-2', name: 'ledger  REVIEWER' }),
            ],
        });
        expect(flat).toContain('uniqueCustomAgentSlugs');
        expect(flat).toContain(
            'agents \\"Ledger reviewer\\" and \\"ledger  REVIEWER\\" share the command name \\"ledger-reviewer\\"; rename one',
        );
    });

    it('reports a non-string agent name as a validation error, not a crash', async () => {
        const flat = await validateConfig({
            customAgents: [agent({ name: ['Ledger'] }), agent({ id: 'b' })],
        });
        expect(flat).toContain('"property":"name"');
        expect(flat).toContain('isString');
    });

    it('rejects an empty agent id', async () => {
        const flat = await validateConfig({
            customAgents: [agent({ id: '' })],
        });
        expect(flat).toContain('"property":"id"');
    });

    it('rejects two CLIs with the same name on one agent', async () => {
        const flat = await validateConfig({
            customAgents: [
                agent({ tools: { cli: [cli(), cli({ binary: 'other' })] } }),
            ],
        });
        expect(flat).toContain('uniqueCliNames');
        expect(
            await validateConfig({
                customAgents: [
                    agent({
                        tools: { cli: [cli(), cli({ name: 'ledger-fmt' })] },
                    }),
                ],
            }),
        ).toBe('[]');
    });

    it('rejects knowledge linked to an agent that is not configured', async () => {
        const flat = await validateConfig({
            customAgents: [agent()],
            knowledge: [
                {
                    path: 'docs/ledger.md',
                    kind: 'doc',
                    linkedTo: [{ agentId: 'agent-missing' }],
                },
            ],
        });
        expect(flat).toContain('knowledgeLinksKnownAgents');
    });

    it('accepts the revisions the screen loaded, and nothing else beside them', async () => {
        const validateBody = async (expectedRevisions: unknown) => {
            const dto = plainToInstance(CreateOrUpdateCodeReviewParameterDto, {
                organizationAndTeamData: { teamId: 'team-1' },
                configValue: { customAgents: [agent()] },
                expectedRevisions,
            });
            return JSON.stringify(
                await validate(dto, {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                }),
            );
        };

        expect(
            await validateBody({ customAgents: 'a1b2', knowledge: 'c3d4' }),
        ).toBe('[]');
        expect(await validateBody({ customAgents: 42 })).toContain(
            'customAgents',
        );
        expect(await validateBody({ agents: 'a1b2' })).toContain('agents');
    });
});
