import {
    collectRepoInstructions,
    quotesRepoInstruction,
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
            shouldCollectRepoInstructions({ repoInstructionsEnabled: true }),
        ).toBe(true);
        expect(
            shouldCollectRepoInstructions({ repoInstructionsEnabled: false }),
        ).toBe(false);
        expect(shouldCollectRepoInstructions({})).toBe(false);
        expect(shouldCollectRepoInstructions(undefined)).toBe(false);
    });

    it('ignores the retired ideRulesSyncEnabled, which meant something else', () => {
        expect(
            shouldCollectRepoInstructions({
                ideRulesSyncEnabled: true,
            } as Parameters<typeof shouldCollectRepoInstructions>[0]),
        ).toBe(false);
    });

    it('skips under the adaptive profiles that drop optional context', () => {
        expect(
            shouldCollectRepoInstructions(
                { repoInstructionsEnabled: true },
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

    it('lists a Cursor rule the agent loads on request instead of inlining it', async () => {
        const repo = files({
            '.cursor/rules/migrations.mdc':
                '---\ndescription: How to write a migration\nalwaysApply: false\n---\nUse expand/contract.',
            '.cursor/rules/style.mdc': '---\nalwaysApply: true\n---\nBe terse.',
            '.cursor/rules/plain.mdc': 'No frontmatter.',
        });

        const result = await collectRepoInstructions({
            ...repo,
            changedFiles: ['src/a.ts'],
        });

        expect(result.files.map((f) => f.path).sort()).toEqual([
            '.cursor/rules/plain.mdc',
            '.cursor/rules/style.mdc',
        ]);
        expect(result.otherFiles).toEqual(['.cursor/rules/migrations.mdc']);
    });

    it("matches a nested rule's bare glob only against files in its directory", async () => {
        const repo = files({
            'services/billing/.cursor/rules/python.mdc':
                '---\nglobs: *.py\nalwaysApply: false\n---\nUse Decimal.',
        });

        const outside = await collectRepoInstructions({
            ...repo,
            changedFiles: ['services/billing/README.md', 'services/auth/a.py'],
        });
        const inside = await collectRepoInstructions({
            ...repo,
            changedFiles: ['services/billing/src/invoice.py'],
        });

        expect(outside.files).toEqual([]);
        expect(inside.files).toEqual([
            expect.objectContaining({
                path: 'services/billing/.cursor/rules/python.mdc',
                appliesTo: '*.py',
            }),
        ]);
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
        expect(result.unreadable).toEqual(['AGENTS.md: 404']);
    });

    it('stops reading once the file budget is full and lists the rest as dropped', async () => {
        const map: Record<string, string> = {};
        for (let i = 0; i < REPO_INSTRUCTIONS_LIMITS.maxFiles + 3; i++) {
            map[`pkg${i}/AGENTS.md`] = 'Use the logger.';
        }
        const repo = files(map);

        const result = await collectRepoInstructions({
            ...repo,
            changedFiles: Object.keys(map).map((p) =>
                p.replace('AGENTS.md', 'a.ts'),
            ),
        });

        expect(result.files).toHaveLength(REPO_INSTRUCTIONS_LIMITS.maxFiles);
        expect(result.dropped).toHaveLength(3);
        expect(repo.readFile).toHaveBeenCalledTimes(
            REPO_INSTRUCTIONS_LIMITS.maxFiles,
        );
    });

    it('still includes a file that fits whole when less than minUsefulBytes is left', async () => {
        const { maxBytesPerFile, maxTotalBytes, minUsefulBytes } =
            REPO_INSTRUCTIONS_LIMITS;
        const left = minUsefulBytes / 2;
        const map: Record<string, string> = {
            'a/AGENTS.md': 'y'.repeat(maxBytesPerFile),
            'b/AGENTS.md': 'y'.repeat(maxBytesPerFile),
            'c/AGENTS.md': 'y'.repeat(
                maxTotalBytes - 2 * maxBytesPerFile - left,
            ),
            'd/AGENTS.md': 'Use the logger.',
            'e/AGENTS.md': 'z'.repeat(minUsefulBytes * 2),
        };
        const repo = files(map);

        const result = await collectRepoInstructions({
            ...repo,
            changedFiles: ['a/x.ts', 'b/x.ts', 'c/x.ts', 'd/x.ts', 'e/x.ts'],
        });

        expect(result.files.map((f) => f.path)).toEqual([
            'a/AGENTS.md',
            'b/AGENTS.md',
            'c/AGENTS.md',
            'd/AGENTS.md',
        ]);
        expect(result.files[3].truncated).toBe(false);
        expect(result.dropped).toEqual(['e/AGENTS.md']);
    });

    it('stops reading once the byte budget is spent', async () => {
        const map: Record<string, string> = {};
        for (let i = 0; i < 4; i++) {
            map[`pkg${i}/AGENTS.md`] = 'y'.repeat(
                REPO_INSTRUCTIONS_LIMITS.maxBytesPerFile,
            );
        }
        const repo = files(map);

        const result = await collectRepoInstructions({
            ...repo,
            changedFiles: Object.keys(map).map((p) =>
                p.replace('AGENTS.md', 'a.ts'),
            ),
        });

        expect(result.files).toHaveLength(3);
        expect(result.dropped).toEqual(['pkg3/AGENTS.md']);
        expect(repo.readFile).toHaveBeenCalledTimes(3);
    });
});

describe('quotesRepoInstruction', () => {
    const context = {
        files: [
            {
                path: 'CLAUDE.md',
                content: [
                    '## Backend',
                    '',
                    '- **Never** import a model directly in API helpers; use the `services` layer.',
                    '- Amounts are integer cents.',
                ].join('\n'),
                appliesTo: '**',
                truncated: false,
            },
        ],
        otherFiles: [],
        dropped: [],
        truncated: false,
        indexedCount: 1,
    };

    it.each([
        ['the exact sentence', 'CLAUDE.md says "Amounts are integer cents."'],
        [
            'different case and spacing',
            'CLAUDE.md says "amounts  are INTEGER cents"',
        ],
        [
            'the text without its markdown',
            'CLAUDE.md says "Never import a model directly in API helpers; use the services layer."',
        ],
        [
            'a trimmed part of it',
            'CLAUDE.md says "import a model directly in API helpers"',
        ],
        [
            'typographic quotes',
            'CLAUDE.md says \u201cAmounts are integer cents.\u201d',
        ],
        [
            'an ellipsis between two parts',
            'CLAUDE.md says "Never import a model directly ... use the services layer"',
        ],
    ])('accepts a quote of %s', (_name, content) => {
        expect(quotesRepoInstruction(content, context)).toBe(true);
    });

    it.each([
        [
            'a rule the files do not state',
            'CLAUDE.md says "Use isinstance() checks instead of getattr on unions."',
        ],
        ['no quote at all', 'This breaks the team convention on amounts.'],
        [
            'a quote too short to identify an instruction',
            'CLAUDE.md says "cents"',
        ],
    ])('rejects %s', (_name, content) => {
        expect(quotesRepoInstruction(content, context)).toBe(false);
    });

    it('rejects every quote when no instructions were collected', () => {
        expect(
            quotesRepoInstruction(
                'CLAUDE.md says "Amounts are integer cents."',
                undefined,
            ),
        ).toBe(false);
    });
});
