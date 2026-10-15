import {
    collectRepoInstructions,
    REPO_INSTRUCTIONS_LIMITS,
    selectGoverningFiles,
    shouldCollectRepoInstructions,
} from './repo-instructions';

const files = (map: Record<string, string>) => ({
    listFiles: jest.fn().mockResolvedValue(Object.keys(map)),
    readFile: jest
        .fn()
        .mockImplementation(async (path: string) => map[path] ?? null),
});

describe('shouldCollectRepoInstructions', () => {
    it('collects only when the repository opted in', () => {
        expect(
            shouldCollectRepoInstructions({ ideRulesSyncEnabled: true }),
        ).toBe(true);
        expect(
            shouldCollectRepoInstructions({ ideRulesSyncEnabled: false }),
        ).toBe(false);
        expect(shouldCollectRepoInstructions({})).toBe(false);
        expect(shouldCollectRepoInstructions(undefined)).toBe(false);
    });

    it('skips under the adaptive profiles that drop optional context', () => {
        expect(
            shouldCollectRepoInstructions(
                { ideRulesSyncEnabled: true },
                { dropCallGraph: true },
            ),
        ).toBe(false);
    });
});

describe('selectGoverningFiles', () => {
    const index = [
        'CLAUDE.md',
        'AGENTS.md',
        'services/billing/CLAUDE.md',
        'services/auth/AGENTS.md',
        'apps/web/.cursor/rules/react.mdc',
        '.claude/settings.json',
        '.aiderignore',
    ];

    it('keeps root files and the files of directories that contain a changed file', () => {
        expect(
            selectGoverningFiles(index, ['services/billing/invoice.ts']),
        ).toEqual(['AGENTS.md', 'CLAUDE.md', 'services/billing/CLAUDE.md']);
    });

    it('drops tool configuration files, which carry no instructions', () => {
        expect(selectGoverningFiles(index, ['README.md'])).toEqual([
            'AGENTS.md',
            'CLAUDE.md',
        ]);
    });

    it('scopes a nested .cursor/rules file to the directory that holds .cursor', () => {
        expect(
            selectGoverningFiles(index, ['apps/web/src/page.tsx']),
        ).toContain('apps/web/.cursor/rules/react.mdc');
        expect(
            selectGoverningFiles(index, ['apps/api/src/main.ts']),
        ).not.toContain('apps/web/.cursor/rules/react.mdc');
    });

    it('does not let a sibling prefix match (services/auth vs services/authz)', () => {
        expect(
            selectGoverningFiles(index, ['services/authz/x.ts']),
        ).not.toContain('services/auth/AGENTS.md');
    });
});

describe('collectRepoInstructions', () => {
    it('inlines the governing files, root first', async () => {
        const repo = files({
            'services/billing/CLAUDE.md': 'Money is integer cents.',
            'CLAUDE.md': 'Use pnpm.',
            'docs/CLAUDE.md': 'Docs only.',
        });

        const result = await collectRepoInstructions({
            ...repo,
            changedFiles: ['services/billing/invoice.ts'],
        });

        expect(result.files.map((f) => f.path)).toEqual([
            'CLAUDE.md',
            'services/billing/CLAUDE.md',
        ]);
        expect(result.files[1]).toMatchObject({
            content: 'Money is integer cents.',
            appliesTo: 'services/billing/**',
            truncated: false,
        });
        expect(result.files[0].appliesTo).toBe('**');
        expect(result.otherFiles).toEqual(['docs/CLAUDE.md']);
        expect(repo.readFile).not.toHaveBeenCalledWith('docs/CLAUDE.md');
    });

    it('narrows .cursor/rules and .github/instructions by their declared globs', async () => {
        const repo = files({
            '.cursor/rules/sql.mdc':
                '---\ndescription: SQL\nglobs: db/**/*.sql\nalwaysApply: false\n---\nNo SELECT *.',
            '.cursor/rules/always.mdc':
                '---\nalwaysApply: true\n---\nWrite tests.',
            '.github/instructions/ts.instructions.md':
                '---\napplyTo: "**/*.ts,**/*.tsx"\n---\nNo any.',
        });

        const result = await collectRepoInstructions({
            ...repo,
            changedFiles: ['src/a.ts'],
        });

        expect(result.files.map((f) => f.path).sort()).toEqual([
            '.cursor/rules/always.mdc',
            '.github/instructions/ts.instructions.md',
        ]);
        expect(
            result.files.find((f) => f.path.endsWith('ts.instructions.md'))
                ?.appliesTo,
        ).toBe('**/*.ts,**/*.tsx');
    });

    it('reads the unquoted globs Cursor writes, which are not valid YAML', async () => {
        const repo = files({
            '.cursor/rules/tsx_tests.mdc':
                '---\ndescription: React tests\nglobs: *.spec.tsx\nalwaysApply: false\n---\nUse RTL.',
            '.cursor/rules/py.mdc':
                '---\nglobs: *.py, src/**/*.pyi\nalwaysApply: false\n---\nType hints.',
            '.cursor/rules/broken-always.mdc':
                '---\nglobs: *.md\nalwaysApply: true\n---\nBe terse.',
        });

        const result = await collectRepoInstructions({
            ...repo,
            changedFiles: ['src/sentry/uptime/consumer.py'],
        });

        expect(
            Object.fromEntries(result.files.map((f) => [f.path, f.appliesTo])),
        ).toEqual({
            '.cursor/rules/broken-always.mdc': '**',
            '.cursor/rules/py.mdc': '*.py,src/**/*.pyi',
        });
    });

    it('truncates a long file and stops at the total budget', async () => {
        const big = 'x'.repeat(REPO_INSTRUCTIONS_LIMITS.maxBytesPerFile + 500);
        const map: Record<string, string> = { 'CLAUDE.md': big };
        for (let i = 0; i < 10; i++) {
            map[`pkg${i}/AGENTS.md`] = 'y'.repeat(9_000);
        }
        const repo = files(map);

        const result = await collectRepoInstructions({
            ...repo,
            changedFiles: Array.from({ length: 10 }, (_, i) => `pkg${i}/a.ts`),
        });

        expect(result.files[0].truncated).toBe(true);
        expect(Buffer.byteLength(result.files[0].content)).toBeLessThanOrEqual(
            REPO_INSTRUCTIONS_LIMITS.maxBytesPerFile,
        );
        const total = result.files.reduce(
            (sum, f) => sum + Buffer.byteLength(f.content),
            0,
        );
        expect(total).toBeLessThanOrEqual(
            REPO_INSTRUCTIONS_LIMITS.maxTotalBytes,
        );
        expect(result.files.length).toBeLessThanOrEqual(
            REPO_INSTRUCTIONS_LIMITS.maxFiles,
        );
        expect(result.dropped.length).toBeGreaterThan(0);
        expect(result.truncated).toBe(true);
    });

    it('skips empty files', async () => {
        const repo = files({ 'CLAUDE.md': '   \n' });

        const result = await collectRepoInstructions({
            ...repo,
            changedFiles: ['a.ts'],
        });

        expect(result.files).toEqual([]);
    });

    it('never throws: a git host failure yields an empty result', async () => {
        const result = await collectRepoInstructions({
            listFiles: jest.fn().mockRejectedValue(new Error('rate limited')),
            readFile: jest.fn(),
            changedFiles: ['a.ts'],
        });

        expect(result).toMatchObject({ files: [], otherFiles: [] });
        expect(result.error).toBe('rate limited');
    });

    it('keeps the files it could read when one read fails', async () => {
        const result = await collectRepoInstructions({
            listFiles: jest
                .fn()
                .mockResolvedValue(['CLAUDE.md', 'AGENTS.md']),
            readFile: jest
                .fn()
                .mockImplementation(async (p: string) => {
                    if (p === 'AGENTS.md') throw new Error('404');
                    return 'Use pnpm.';
                }),
            changedFiles: ['a.ts'],
        });

        expect(result.files.map((f) => f.path)).toEqual(['CLAUDE.md']);
    });
});
