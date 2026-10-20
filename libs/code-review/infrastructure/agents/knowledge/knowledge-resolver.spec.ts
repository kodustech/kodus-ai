import {
    CUSTOM_AGENT_LIMITS,
    type KnowledgeItem,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { InMemoryBaseBranchReader, skillMarkdown } from './knowledge.fixtures';
import { MAX_SKILL_FILES } from './knowledge-path';
import {
    DOCS_TRUNCATED_MARKER,
    KnowledgeResolver,
    locateSkill,
    toReviewWarnings,
} from './knowledge-resolver';

const SKILL_DIR = '.claude/skills/ledger-errors';

const baseFiles = (): Record<string, string> => ({
    [`${SKILL_DIR}/SKILL.md`]: skillMarkdown(
        'ledger-errors',
        'How the ledger team raises and maps errors.',
    ),
    [`${SKILL_DIR}/references/codes.md`]: 'LEDGER-001 insufficient funds',
    [`${SKILL_DIR}/scripts/check.sh`]: 'rm -rf /',
    '.claude/agents/migration-reviewer.md': skillMarkdown(
        'migration-reviewer',
        'Checks ledger schema migrations.',
    ),
    'docs/conventions/naming.md': '# Naming\n\nUse ledgerEntry, never entry.',
    'docs/conventions/money.md': '# Money\n\nAmounts are integer cents.',
});

describe('locateSkill', () => {
    it('accepts a folder, its SKILL.md or a single-file skill', () => {
        expect(locateSkill(SKILL_DIR)).toEqual({
            skillFile: `${SKILL_DIR}/SKILL.md`,
            folder: SKILL_DIR,
            expectedName: 'ledger-errors',
        });
        expect(locateSkill(`${SKILL_DIR}/SKILL.md`)?.folder).toBe(SKILL_DIR);
        expect(locateSkill('.claude/agents/migration-reviewer.md')).toEqual({
            skillFile: '.claude/agents/migration-reviewer.md',
            folder: null,
            expectedName: 'migration-reviewer',
        });
        expect(locateSkill('../elsewhere')).toBeNull();
    });
});

describe('KnowledgeResolver', () => {
    const items: KnowledgeItem[] = [
        { path: SKILL_DIR, kind: 'skill', linkedTo: ['main-review'] },
        {
            path: '.claude/agents/migration-reviewer.md',
            kind: 'skill',
            linkedTo: [{ agentId: 'agent-migrations' }],
        },
        {
            path: 'docs/conventions/*.md',
            kind: 'doc',
            linkedTo: [{ agentId: 'agent-migrations' }],
        },
    ];

    it('gives each target only the knowledge linked to it', async () => {
        const resolver = new KnowledgeResolver(
            new InMemoryBaseBranchReader(baseFiles()),
        );

        const all = await resolver.resolveAll({
            items,
            agentIds: ['agent-migrations', 'agent-unlinked'],
        });

        expect([...all.keys()]).toEqual(['main-review', 'agent-migrations']);
        const main = all.get('main-review')!;
        expect(main.skills.map((s) => s.name)).toEqual(['ledger-errors']);
        expect(main.skills[0].files).toEqual([
            'references/codes.md',
            'scripts/check.sh',
        ]);
        expect(main.docs).toEqual([]);

        const agent = all.get('agent-migrations')!;
        expect(agent.skills.map((s) => s.name)).toEqual(['migration-reviewer']);
        expect(agent.skills[0].folder).toBeNull();
        expect(agent.docs.map((d) => d.path)).toEqual([
            'docs/conventions/money.md',
            'docs/conventions/naming.md',
        ]);
        expect(agent.warnings).toEqual([]);
    });

    it('lists skill files at any depth inside the folder, as readSkillFile serves them', async () => {
        const resolver = new KnowledgeResolver(
            new InMemoryBaseBranchReader({
                ...baseFiles(),
                [`${SKILL_DIR}/references/deep/nested.md`]: 'too deep',
                [`${SKILL_DIR}/NOTES.md`]: 'top-level note',
            }),
        );

        const main = await resolver.resolve({ items, target: 'main-review' });

        expect(main.skills[0].files).toEqual([
            'NOTES.md',
            'references/codes.md',
            'references/deep/nested.md',
            'scripts/check.sh',
        ]);
    });

    it('lists at most the cap of a large skill folder, shallow files first', async () => {
        const many: Record<string, string> = {};
        for (let i = 0; i < MAX_SKILL_FILES + 5; i++) {
            many[
                `${SKILL_DIR}/references/deep/r${String(i).padStart(3, '0')}.md`
            ] = 'x';
        }
        const resolver = new KnowledgeResolver(
            new InMemoryBaseBranchReader({
                ...baseFiles(),
                ...many,
                [`${SKILL_DIR}/NOTES.md`]: 'top-level note',
            }),
        );

        const main = await resolver.resolve({ items, target: 'main-review' });

        expect(main.skills[0].files).toHaveLength(MAX_SKILL_FILES);
        expect(main.skills[0].files).toContain('NOTES.md');
        expect(main.skills[0].files).toContain('references/codes.md');
    });

    it('reads a skill linked to two targets once', async () => {
        const reader = new InMemoryBaseBranchReader(baseFiles());
        const resolver = new KnowledgeResolver(reader);

        await resolver.resolveAll({
            items: [
                {
                    path: SKILL_DIR,
                    kind: 'skill',
                    linkedTo: ['main-review', { agentId: 'a1' }],
                },
            ],
            agentIds: ['a1'],
        });

        expect(
            reader.reads.filter((p) => p === `${SKILL_DIR}/SKILL.md`),
        ).toHaveLength(1);
    });

    it('warns SKILL_NOT_FOUND and SKILL_INVALID without failing', async () => {
        const files = baseFiles();
        files['.claude/skills/bad-name/SKILL.md'] = skillMarkdown(
            'bad-name',
            '',
        );
        const resolver = new KnowledgeResolver(
            new InMemoryBaseBranchReader(files),
        );

        const result = await resolver.resolve({
            target: 'main-review',
            items: [
                {
                    path: '.claude/skills/missing',
                    kind: 'skill',
                    linkedTo: ['main-review'],
                },
                {
                    path: '.claude/skills/bad-name',
                    kind: 'skill',
                    linkedTo: ['main-review'],
                },
                { path: SKILL_DIR, kind: 'skill', linkedTo: ['main-review'] },
            ],
        });

        expect(result.skills.map((s) => s.name)).toEqual(['ledger-errors']);
        expect(result.warnings.map((w) => [w.code, w.path])).toEqual([
            ['SKILL_NOT_FOUND', '.claude/skills/missing'],
            ['SKILL_INVALID', '.claude/skills/bad-name'],
        ]);
        expect(result.warnings[1].detail).toMatch(/description is required/);
    });

    it('warns SKILL_CHANGED_IN_PR when the PR edits a linked skill or doc', async () => {
        const resolver = new KnowledgeResolver(
            new InMemoryBaseBranchReader(baseFiles()),
        );

        const main = await resolver.resolve({
            target: 'main-review',
            items,
            changedFiles: [`${SKILL_DIR}/references/codes.md`, 'src/ledger.ts'],
        });
        const agent = await resolver.resolve({
            target: { agentId: 'agent-migrations' },
            items,
            changedFiles: ['docs/conventions/money.md'],
        });

        expect(main.warnings.map((w) => w.code)).toEqual([
            'SKILL_CHANGED_IN_PR',
        ]);
        expect(main.skills[0].body).toContain('Raise LedgerError');
        expect(agent.warnings).toEqual([
            expect.objectContaining({
                code: 'SKILL_CHANGED_IN_PR',
                path: 'docs/conventions/money.md',
            }),
        ]);
    });

    it('surfaces compatibility and body truncation as warnings', async () => {
        const files = baseFiles();
        files[`${SKILL_DIR}/SKILL.md`] = skillMarkdown(
            'ledger-errors',
            'Long skill.',
            Array.from({ length: 600 }, (_, i) => `rule ${i}`).join('\n'),
            'compatibility: Needs the ledger CLI\n',
        );
        const resolver = new KnowledgeResolver(
            new InMemoryBaseBranchReader(files),
        );

        const result = await resolver.resolve({ target: 'main-review', items });

        expect(result.warnings.map((w) => w.code).sort()).toEqual([
            'KNOWLEDGE_TRUNCATED',
            'SKILL_COMPATIBILITY',
        ]);
        expect(result.skills[0].bodyTruncated).toBe(true);
    });

    it('cuts docs at the token budget with a marker and a warning', async () => {
        const big = Array.from(
            { length: 400 },
            (_, i) => `- rule ${i}: amounts are integer cents in the ledger`,
        ).join('\n');
        const resolver = new KnowledgeResolver(
            new InMemoryBaseBranchReader({
                'docs/a.md': 'short doc',
                'docs/b.md': big,
                'docs/c.md': 'never reached',
            }),
            { docTokenBudget: 1000 },
        );

        const result = await resolver.resolve({
            target: 'main-review',
            items: ['docs/a.md', 'docs/b.md', 'docs/c.md'].map((path) => ({
                path,
                kind: 'doc' as const,
                linkedTo: ['main-review' as const],
            })),
        });

        expect(result.docs.map((d) => [d.path, d.truncated])).toEqual([
            ['docs/a.md', false],
            ['docs/b.md', true],
        ]);
        expect(result.docs[0].content).toBe('short doc');
        expect(result.docs[1].content).toContain(DOCS_TRUNCATED_MARKER(1000));
        expect(result.docs[1].content.length).toBeLessThan(big.length);
        expect(result.warnings.map((w) => [w.code, w.path])).toEqual([
            ['KNOWLEDGE_TRUNCATED', 'docs/b.md'],
            ['KNOWLEDGE_TRUNCATED', 'docs/c.md'],
        ]);
    });

    it('uses the 20k token default budget', async () => {
        const doc = 'word '.repeat(30000);
        const resolver = new KnowledgeResolver(
            new InMemoryBaseBranchReader({ 'docs/huge.md': doc }),
        );

        const result = await resolver.resolve({
            target: 'main-review',
            items: [
                {
                    path: 'docs/huge.md',
                    kind: 'doc',
                    linkedTo: ['main-review'],
                },
            ],
        });

        expect(CUSTOM_AGENT_LIMITS.maxDocTokens).toBe(20000);
        expect(result.docs[0].truncated).toBe(true);
    });

    it('caps a doc glob at the per-target doc limit', async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < CUSTOM_AGENT_LIMITS.maxDocs + 3; i++) {
            files[`docs/adr/${String(i).padStart(2, '0')}.md`] = `ADR ${i}`;
        }
        const resolver = new KnowledgeResolver(
            new InMemoryBaseBranchReader(files),
        );

        const result = await resolver.resolve({
            target: 'main-review',
            items: [
                {
                    path: 'docs/adr/*.md',
                    kind: 'doc',
                    linkedTo: ['main-review'],
                },
            ],
        });

        expect(result.docs).toHaveLength(CUSTOM_AGENT_LIMITS.maxDocs);
        expect(result.warnings.map((w) => w.code)).toEqual([
            'KNOWLEDGE_TRUNCATED',
        ]);
    });

    it('warns DOC_NOT_FOUND for a missing doc, an empty glob and a traversal path', async () => {
        const resolver = new KnowledgeResolver(
            new InMemoryBaseBranchReader(baseFiles()),
        );

        const result = await resolver.resolve({
            target: 'main-review',
            items: ['docs/gone.md', 'docs/none/*.md', '../secrets/*.md'].map(
                (path) => ({
                    path,
                    kind: 'doc' as const,
                    linkedTo: ['main-review' as const],
                }),
            ),
        });

        expect(result.docs).toEqual([]);
        expect(result.warnings.map((w) => w.code)).toEqual([
            'DOC_NOT_FOUND',
            'DOC_NOT_FOUND',
            'DOC_NOT_FOUND',
        ]);
    });
});

describe('toReviewWarnings', () => {
    it('maps knowledge warnings to review warnings for the agent', () => {
        expect(
            toReviewWarnings(
                [
                    {
                        code: 'SKILL_NOT_FOUND',
                        path: 'skills/x',
                        detail: 'no SKILL.md on main',
                    },
                ],
                'Ledger reviewer',
            ),
        ).toEqual([
            {
                kind: 'SKILL_NOT_FOUND',
                reason: 'knowledge',
                contextWindowTokens: 0,
                modelName: '',
                detail: 'skills/x: no SKILL.md on main',
                agentName: 'Ledger reviewer',
            },
        ]);
    });
});
