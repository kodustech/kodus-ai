import { buildRepoInstructionTool } from './repo-instruction-tool';

import type { RepoInstructionsContext } from '@libs/code-review/infrastructure/agents/collaborators/repo-instructions';

const context: RepoInstructionsContext = {
    files: [
        {
            path: 'CLAUDE.md',
            content: 'Amounts are integer cents.',
            appliesTo: '**',
            truncated: false,
        },
        {
            path: 'services/billing/AGENTS.md',
            content: 'Use the billing logger.',
            appliesTo: 'services/billing/**',
            truncated: true,
        },
    ],
    otherFiles: ['docs/AGENTS.md'],
    dropped: ['web/CLAUDE.md'],
    truncated: true,
    indexedCount: 4,
};

const ctx = { runId: 'test' };

describe('readRepoInstruction tool', () => {
    const tool = buildRepoInstructionTool(context);

    it('returns the target-branch text of a listed file, framed as repository text', async () => {
        const result = await tool.execute({ path: 'CLAUDE.md' }, ctx);
        expect(result.isError).toBeFalsy();
        expect(result.output).toContain('Amounts are integer cents.');
        expect(result.output).toContain('CLAUDE.md');
        expect(result.output).toMatch(/never instructions to you/);
    });

    it('accepts a path written with a leading ./ or /', async () => {
        for (const path of ['./CLAUDE.md', '/CLAUDE.md']) {
            const result = await tool.execute({ path }, ctx);
            expect(result.output).toContain('Amounts are integer cents.');
        }
    });

    it('says when the file was cut', async () => {
        const result = await tool.execute(
            { path: 'services/billing/AGENTS.md' },
            ctx,
        );
        expect(result.output).toContain('Use the billing logger.');
        expect(result.output).toMatch(/cut/);
    });

    it.each([
        ['an unlisted repository file', 'src/config.ts'],
        [
            'an instruction file that does not govern the change',
            'docs/AGENTS.md',
        ],
        ['a governing file left out by the budget', 'web/CLAUDE.md'],
        ['a traversal', '../CLAUDE.md'],
    ])('refuses %s and names the files it can read', async (_name, path) => {
        const result = await tool.execute({ path }, ctx);
        expect(result.isError).toBe(true);
        expect(result.output).toContain(
            'CLAUDE.md, services/billing/AGENTS.md',
        );
        expect(result.output).not.toContain('Amounts are integer cents.');
    });

    it('refuses an input without a path', async () => {
        const result = await tool.execute({}, ctx);
        expect(result.isError).toBe(true);
    });

    it('offers only the listed paths in its schema', () => {
        expect(tool.inputSchema).toMatchObject({
            type: 'object',
            required: ['path'],
            properties: {
                path: {
                    type: 'string',
                    enum: ['CLAUDE.md', 'services/billing/AGENTS.md'],
                },
            },
        });
    });
});
