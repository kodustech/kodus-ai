import {
    CUSTOM_AGENT_LIMITS,
    customAgentConfigSchema,
    customAgentsSchema,
    knowledgeLinkProblems,
} from './codeReview.type';

const cli = (
    name: string,
    install = 'npm install -g @acme-ledger/lint@2.4.1',
) => ({
    name,
    install,
    binary: 'ledger-lint',
    allowedPrefixes: ['ledger-lint check'],
    usage: 'Run `ledger-lint check <path>`.',
    runsProjectCode: false,
    allowedDomains: ['registry.npmjs.org'],
});

const agent = (id: string, clis: ReturnType<typeof cli>[] = []) => ({
    id,
    name: `Reviewer ${id}`,
    enabled: true,
    instructions: 'Every posting must balance debits and credits.',
    scope: { include: ['src/ledger/**'] },
    tools: { cli: clis },
    presentation: {
        tag: { color: '#304FFE' },
        format: 'inline',
        suggestedFix: 'when-confident',
    },
});

describe('custom agent config schemas', () => {
    it('accepts an agent without a presentation mode', () => {
        expect(customAgentConfigSchema.safeParse(agent('ledger')).success).toBe(
            true,
        );
    });

    it('still accepts a config saved with the retired mode', () => {
        for (const mode of ['shadow', 'post']) {
            const legacy = agent('ledger');
            expect(
                customAgentConfigSchema.safeParse({
                    ...legacy,
                    presentation: { ...legacy.presentation, mode },
                }).success,
            ).toBe(true);
        }
    });

    it('refuses ast-grep rules over the size the tool runs', () => {
        const withRules = (astGrepConfig: string) => ({
            ...agent('ledger'),
            tools: { astGrepConfig },
        });
        const limit = CUSTOM_AGENT_LIMITS.maxAstGrepRuleBytes;
        expect(
            customAgentConfigSchema.safeParse(withRules('x'.repeat(limit)))
                .success,
        ).toBe(true);
        // Bytes, not characters: 'é' is two bytes in UTF-8.
        const parsed = customAgentConfigSchema.safeParse(
            withRules('é'.repeat(limit / 2 + 1)),
        );
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed.error?.issues)).toContain('astGrepConfig');
    });

    it('refuses an install with any unpinned package', () => {
        expect(
            customAgentConfigSchema.safeParse(
                agent('ledger', [
                    cli('lint', 'npm install -g a@latest b@1.2.3'),
                ]),
            ).success,
        ).toBe(false);
        expect(
            customAgentConfigSchema.safeParse(agent('ledger', [cli('lint')]))
                .success,
        ).toBe(true);
    });

    it('refuses two CLIs with the same name on one agent', () => {
        expect(
            customAgentConfigSchema.safeParse(
                agent('ledger', [cli('lint'), cli('lint')]),
            ).success,
        ).toBe(false);
    });

    it('refuses two agents with the same id', () => {
        expect(
            customAgentsSchema.safeParse([agent('ledger'), agent('ledger')])
                .success,
        ).toBe(false);
        expect(
            customAgentsSchema.safeParse([agent('ledger'), agent('billing')])
                .success,
        ).toBe(true);
    });

    it('names knowledge links to agents that do not exist', () => {
        expect(
            knowledgeLinkProblems(
                [
                    {
                        path: 'docs/ledger.md',
                        kind: 'doc',
                        linkedTo: ['main-review', { agentId: 'ghost' }],
                    },
                ],
                [agent('ledger')],
            ),
        ).toEqual(['docs/ledger.md links to unknown agent "ghost"']);
        expect(
            knowledgeLinkProblems(
                [
                    {
                        path: 'docs/ledger.md',
                        kind: 'doc',
                        linkedTo: [{ agentId: 'ledger' }],
                    },
                ],
                [agent('ledger')],
            ),
        ).toEqual([]);
    });
});
