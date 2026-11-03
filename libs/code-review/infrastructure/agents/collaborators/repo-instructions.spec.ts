import {
    collectRepoInstructions,
    quotesRepoInstruction,
    citesRepoInstruction,
    isRepoInstructionFile,
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

    it('truncates a long file and stops at the total budget, dropping the furthest first', async () => {
        const big = 'x'.repeat(REPO_INSTRUCTIONS_LIMITS.maxBytesPerFile + 500);
        const map: Record<string, string> = {
            'CLAUDE.md': 'Use pnpm.',
            'pkg0/AGENTS.md': big,
        };
        for (let i = 1; i < 10; i++) {
            map[`pkg${i}/AGENTS.md`] = 'y'.repeat(9_000);
        }
        const repo = files(map);

        const result = await collectRepoInstructions({
            ...repo,
            changedFiles: Array.from({ length: 10 }, (_, i) => `pkg${i}/a.ts`),
        });

        const long = result.files.find((f) => f.path === 'pkg0/AGENTS.md')!;
        expect(long.truncated).toBe(true);
        expect(Buffer.byteLength(long.content)).toBeLessThanOrEqual(
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
        expect(result.dropped).toContain('CLAUDE.md');
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

    // A host can list one file twice (overlapping directory scans); it must
    // still take one slot of the budget and be read once.
    it('lists a file the host returned twice once', async () => {
        const repo = {
            listFiles: jest
                .fn()
                .mockResolvedValue([
                    '.github/instructions/api.instructions.md',
                    'CLAUDE.md',
                    '/.github/instructions/api.instructions.md',
                    '.github/instructions/api.instructions.md',
                ]),
            readFile: jest
                .fn()
                .mockImplementation(async (p: string) =>
                    p === 'CLAUDE.md' ? 'Use pnpm.' : 'Use the logger.',
                ),
        };

        const result = await collectRepoInstructions({
            ...repo,
            changedFiles: ['a.ts'],
        });

        expect(result.files.map((f) => f.path)).toEqual([
            '.github/instructions/api.instructions.md',
            'CLAUDE.md',
        ]);
        expect(result.indexedCount).toBe(2);
        expect(repo.readFile).toHaveBeenCalledTimes(2);
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

    // When the budget is full, the files nearest the change win: a large root
    // file and everything a root file imports must not push out the CLAUDE.md
    // next to the changed code. The prompt still lists them root first.
    it('keeps the files nearest the change when the budget is full', async () => {
        const map: Record<string, string> = {
            '.github/copilot-instructions.md': 'x'.repeat(200_000),
            'AGENTS.md': Array.from(
                { length: REPO_INSTRUCTIONS_LIMITS.maxFiles },
                (_, i) => `@docs/guide${i}.md`,
            ).join('\n'),
            'services/billing/CLAUDE.md': 'Amounts are integer cents.',
            'services/billing/AGENTS.md': '@../../docs/billing-guide.md',
            'docs/billing-guide.md': 'Refunds go through the ledger.',
        };
        for (let i = 0; i < REPO_INSTRUCTIONS_LIMITS.maxFiles; i++) {
            map[`docs/guide${i}.md`] = `Root rule ${i}.`;
        }

        const result = await collectRepoInstructions({
            ...files(map),
            changedFiles: ['services/billing/pay.ts'],
        });
        const paths = result.files.map((f) => f.path);

        expect(paths).toContain('services/billing/CLAUDE.md');
        // A pointer's target takes its source's place.
        expect(paths).toContain('docs/billing-guide.md');
        expect(paths).toHaveLength(REPO_INSTRUCTIONS_LIMITS.maxFiles);
        // Root first, the billing files last.
        expect(paths[0]).toBe('.github/copilot-instructions.md');
        expect(paths.slice(-2)).toEqual([
            'docs/billing-guide.md',
            'services/billing/CLAUDE.md',
        ]);
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
                    '- Use "strict" mode.',
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
        [
            'an instruction that itself contains quotes',
            'CLAUDE.md says "Use "strict" mode."',
        ],
        [
            'an instruction with quotes, after another quote',
            'The line sets "loose" but CLAUDE.md says "Use "strict" mode."',
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

    // Content is LLM output with no length bound; trying every pair of quote
    // marks against a full 64 KB budget took seconds with 200 of them.
    it('stays fast on a finding full of quotes that match nothing', () => {
        const big = {
            ...context,
            files: [{ ...context.files[0], content: 'x'.repeat(64_000) }],
        };
        const text = Array.from(
            { length: 400 },
            (_, i) => `"quoted thing number ${i}"`,
        ).join(' and ');

        const started = Date.now();
        expect(quotesRepoInstruction(text, big)).toBe(false);
        expect(Date.now() - started).toBeLessThan(500);
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

// A CLAUDE.md or AGENTS.md often only points at the guide that holds the
// instructions (`AI-AGENTS.md`, `@docs/guide.md`). The target is read from the
// target branch and listed in its place, within the same budget.
describe('collectRepoInstructions — pointers to another file', () => {
    const guide =
        '# Guide\n\nUse the structured logger. Never call console.log.';

    it('lists the file a pure pointer names, in place of the pointer', async () => {
        const result = await collectRepoInstructions({
            ...files({ 'CLAUDE.md': 'AI-AGENTS.md\n', 'AI-AGENTS.md': guide }),
            changedFiles: ['src/a.ts'],
        });

        expect(result.files.map((f) => [f.path, f.appliesTo])).toEqual([
            ['AI-AGENTS.md', '**'],
        ]);
        expect(result.files[0].content).toContain('Never call console.log.');
    });

    it('lists both a file with its own instructions and the file it imports with @', async () => {
        const result = await collectRepoInstructions({
            ...files({
                'CLAUDE.md':
                    'Amounts are integer cents.\n\nSee @docs/guide.md for the rest.',
                'docs/guide.md': guide,
            }),
            changedFiles: ['src/a.ts'],
        });

        expect(result.files.map((f) => f.path)).toEqual([
            'CLAUDE.md',
            'docs/guide.md',
        ]);
    });

    it('resolves a pointer relative to the file that holds it, and lists a target once', async () => {
        const result = await collectRepoInstructions({
            ...files({
                'CLAUDE.md': 'AI-AGENTS.md',
                'AGENTS.md': 'AI-AGENTS.md',
                '.github/instructions/copilot.instructions.md':
                    '../../AI-AGENTS.md',
                'AI-AGENTS.md': guide,
            }),
            changedFiles: ['src/a.ts'],
        });

        expect(result.files.map((f) => f.path)).toEqual(['AI-AGENTS.md']);
    });

    it("gives a nested pointer's target the pointer's scope", async () => {
        const result = await collectRepoInstructions({
            ...files({
                'services/billing/CLAUDE.md': 'GUIDE.md',
                'services/billing/GUIDE.md': guide,
            }),
            changedFiles: ['services/billing/pay.ts'],
        });

        expect(result.files.map((f) => [f.path, f.appliesTo])).toEqual([
            ['services/billing/GUIDE.md', 'services/billing/**'],
        ]);
    });

    it('gives a target named by two scoped pointers both scopes', async () => {
        const result = await collectRepoInstructions({
            ...files({
                'billing/CLAUDE.md': '../shared.md',
                'checkout/CLAUDE.md': '../shared.md',
                'shared.md': guide,
            }),
            changedFiles: ['billing/pay.ts', 'checkout/cart.ts'],
        });

        expect(result.files.map((f) => [f.path, f.appliesTo])).toEqual([
            ['shared.md', 'billing/**,checkout/**'],
        ]);
    });

    it("passes a second pointer's scope on to the files its target points to", async () => {
        const result = await collectRepoInstructions({
            ...files({
                'billing/CLAUDE.md': '../shared.md',
                'checkout/CLAUDE.md': '../shared.md',
                'shared.md': 'Rule shared.\n@docs/deep.md',
                'docs/deep.md': guide,
            }),
            changedFiles: ['billing/pay.ts', 'checkout/cart.ts'],
        });

        expect(result.files.map((f) => [f.path, f.appliesTo])).toEqual([
            ['shared.md', 'billing/**,checkout/**'],
            ['docs/deep.md', 'billing/**,checkout/**'],
        ]);
    });

    it('follows a chain of pointers and stops at a cycle', async () => {
        const repo = files({
            'CLAUDE.md': '@a.md',
            'a.md': 'Rule A.\n@b.md',
            'b.md': 'Rule B.\n@a.md',
        });

        const result = await collectRepoInstructions({
            ...repo,
            changedFiles: ['src/x.ts'],
        });

        expect(result.files.map((f) => f.path)).toEqual(['a.md', 'b.md']);
    });

    it('never reads a target outside the repository', async () => {
        const repo = files({ 'CLAUDE.md': '../../../etc/secrets.md' });

        const result = await collectRepoInstructions({
            ...repo,
            changedFiles: ['src/x.ts'],
        });

        expect(repo.readFile).not.toHaveBeenCalledWith(
            expect.stringContaining('etc/secrets.md'),
        );
        expect(result.files.map((f) => f.path)).toEqual(['CLAUDE.md']);
    });

    it('keeps a pointer whose target does not exist', async () => {
        const result = await collectRepoInstructions({
            ...files({ 'CLAUDE.md': 'MISSING.md' }),
            changedFiles: ['src/x.ts'],
        });

        expect(result.files.map((f) => f.path)).toEqual(['CLAUDE.md']);
    });

    it('counts targets against the file budget', async () => {
        const map: Record<string, string> = { 'CLAUDE.md': '' };
        const targets = Array.from(
            { length: REPO_INSTRUCTIONS_LIMITS.maxFiles + 2 },
            (_, i) => `docs/g${i}.md`,
        );
        map['CLAUDE.md'] = targets.map((t) => `@${t}`).join('\n');
        for (const t of targets) map[t] = `Rule ${t}.`;

        const result = await collectRepoInstructions({
            ...files(map),
            changedFiles: ['src/x.ts'],
        });

        expect(result.files).toHaveLength(REPO_INSTRUCTIONS_LIMITS.maxFiles);
        expect(result.dropped.length).toBeGreaterThan(0);
    });
});

describe('citesRepoInstruction', () => {
    const context = {
        files: [
            {
                path: 'docs/shared-guide.md',
                content: 'Errors are DomainErrors.',
                appliesTo: '**',
                truncated: false,
            },
        ],
        otherFiles: [],
        dropped: [],
        truncated: false,
        indexedCount: 1,
    };
    const finding = (
        suggestionContent: string,
        code: { existingCode?: string; improvedCode?: string } = {},
    ) => ({ suggestionContent, ...code });

    // The finding reasons from the file: it is the authority for the claim.
    it.each([
        'apps/billing/CLAUDE.md says "Amounts are integer cents."',
        'This breaks `AGENTS.md`.',
        'Per .cursor/rules/style.mdc, no default exports.',
        'As .github/copilot-instructions.md requires, use the logger.',
        'console.warn in src/ violates the src/shared/AGENTS.md logging rule.',
        'Throw a DomainError subclass, per the rule in `docs/shared-guide.md`.',
    ])('finds a citation in %p', (text) => {
        expect(citesRepoInstruction(finding(text), context)).toBe(true);
    });

    it('finds a file the review collected, such as a pointer target', () => {
        const text = finding('Per docs/shared-guide.md, throw a DomainError.');
        expect(citesRepoInstruction(text, context)).toBe(true);
        expect(citesRepoInstruction(text, undefined)).toBe(false);
    });

    // A bug in code that handles these files names them without reasoning
    // from them; it is a bug like any other.
    it.each([
        finding(
            'The glob `**/AGENTS.md` misses nested AGENTS.md files, so loadInstructions() returns [] for apps/*.',
            {
                existingCode:
                    "const files = glob.sync('**/AGENTS.md', { deep: 1 });",
            },
        ),
        finding(
            "readFileSync('CLAUDE.md') throws ENOENT when the repo has no CLAUDE.md; wrap it in existsSync.",
            { existingCode: "const text = readFileSync('CLAUDE.md', 'utf8');" },
        ),
        finding(
            'The parser drops .cursor/rules/api.mdc frontmatter when globs is unquoted.',
        ),
    ])('finds no citation in a bug about the files themselves (%#)', (f) => {
        expect(citesRepoInstruction(f, context)).toBe(false);
    });

    // improvedCode is the model's own suggestion; a comment there citing the
    // file does not make the finding about code that handles it.
    it('finds one whose suggested code repeats the citation', () => {
        expect(
            citesRepoInstruction(
                finding('CLAUDE.md requires the structured logger here.', {
                    existingCode: "console.log('charge')",
                    improvedCode:
                        "// CLAUDE.md requires the logger\nlogger.info('charge')",
                }),
                context,
            ),
        ).toBe(true);
    });

    it('still finds one when another sentence reasons from a file the code names', () => {
        expect(
            citesRepoInstruction(
                finding(
                    'readFileSync on CLAUDE.md runs at import. AGENTS.md requires lazy reads of config files.',
                    { existingCode: "readFileSync('CLAUDE.md')" },
                ),
                context,
            ),
        ).toBe(true);
    });

    it.each([
        'See README.md for the API.',
        'The claude client in src/claude.ts leaks the key.',
        'The loop reads past the end of the array.',
    ])('finds nothing in %p', (text) => {
        expect(citesRepoInstruction(finding(text), context)).toBe(false);
    });
});

describe('isRepoInstructionFile', () => {
    it('is true for a coding-agent file or a collected file, false otherwise', () => {
        expect(isRepoInstructionFile('services/api/AGENTS.md', undefined)).toBe(
            true,
        );
        expect(
            isRepoInstructionFile('docs/guide.md', {
                files: [
                    {
                        path: 'docs/guide.md',
                        content: 'x',
                        appliesTo: '**',
                        truncated: false,
                    },
                ],
                otherFiles: [],
                dropped: [],
                truncated: false,
                indexedCount: 1,
            }),
        ).toBe(true);
        expect(isRepoInstructionFile('src/a.ts', undefined)).toBe(false);
    });
});
