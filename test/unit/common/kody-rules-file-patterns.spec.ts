import {
    IDE_RULE_DIR_MARKERS,
    RULE_FILE_PATTERNS,
    extractRepoSubdirFromIdeSource,
    isIdeRuleSource,
    pathMatchesIdeRuleDir,
    validateAndScopeIdeRulePath,
} from '../../../libs/common/utils/kody-rules/file-patterns';

describe('IDE_RULE_DIR_MARKERS', () => {
    it('is derived from RULE_FILE_PATTERNS — every pattern with a directory part contributes a marker', () => {
        // Sanity: invariant the implementation depends on. If anyone adds
        // a pattern with a directory part to RULE_FILE_PATTERNS, the
        // marker derivation must pick it up at module load.
        for (const pattern of RULE_FILE_PATTERNS) {
            const fixedPrefix = pattern.split(/[*?[]/)[0];
            const dir = fixedPrefix.endsWith('/')
                ? fixedPrefix.slice(0, -1)
                : require('path').posix.dirname(fixedPrefix);
            if (!dir || dir === '.') continue;
            expect(IDE_RULE_DIR_MARKERS).toContain(dir);
        }
    });

    it('is sorted longest-first so deeper markers win over their parents', () => {
        // Otherwise stripping ".cursor" first would leave a stray
        // "/rules" hanging in the subdir.
        for (let i = 1; i < IDE_RULE_DIR_MARKERS.length; i += 1) {
            expect(IDE_RULE_DIR_MARKERS[i - 1].length).toBeGreaterThanOrEqual(
                IDE_RULE_DIR_MARKERS[i].length,
            );
        }
    });

    it('has no duplicates', () => {
        expect(IDE_RULE_DIR_MARKERS.length).toBe(
            new Set(IDE_RULE_DIR_MARKERS).size,
        );
    });

    it('covers every IDE/agent pattern shipped today', () => {
        // Spot-check: each marker corresponds to the directory portion of
        // a pattern's fixed prefix. Patterns whose fixed prefix has no
        // directory part (`.cursorrules`, `CLAUDE.md`, `.windsurfrules`,
        // ...) intentionally don't contribute markers — they live at the
        // repo root by definition.
        expect(IDE_RULE_DIR_MARKERS).toEqual(
            expect.arrayContaining([
                '.cursor/rules', // .cursor/rules/**/*.mdc
                '.kody/rules', // .kody/rules/**
                '.github/instructions', // .github/instructions/**/*.instructions.md
                '.github', // .github/copilot-instructions.md
                '.claude', // .claude/settings.json
                '.sourcegraph', // .sourcegraph/**/*.rule.md
                '.rules', // .rules/**/*
                'docs/coding-standards', // docs/coding-standards/**/*
            ]),
        );
    });

    it('does NOT contain bare ".cursor" or ".kody" — those have no isolated pattern', () => {
        // We only ship `.cursor/rules/**/*.mdc` and `.kody/rules/**`, not
        // bare `.cursor/...` or `.kody/...`. If somebody later adds a
        // pattern like `.cursor/foo.json`, the marker `.cursor` will
        // start appearing automatically and this guard will fail — at
        // which point the assertion just needs to be removed.
        expect(IDE_RULE_DIR_MARKERS).not.toContain('.cursor');
        expect(IDE_RULE_DIR_MARKERS).not.toContain('.kody');
    });
});

describe('extractRepoSubdirFromIdeSource', () => {
    const cases: Array<{
        name: string;
        source: string;
        expected: string | null;
    }> = [
        // Root-level IDE configs (no subdir → repo-wide rule)
        {
            name: '.cursor/rules at repo root',
            source: '.cursor/rules/foo.mdc',
            expected: null,
        },
        {
            name: '.kody/rules at repo root',
            source: '.kody/rules/security.md',
            expected: null,
        },
        {
            name: '.github/instructions at repo root',
            source: '.github/instructions/api.instructions.md',
            expected: null,
        },
        {
            name: '.cursorrules at repo root',
            source: '.cursorrules',
            expected: null,
        },
        {
            name: 'CLAUDE.md at repo root',
            source: 'CLAUDE.md',
            expected: null,
        },
        // Subdir IDE configs (must strip the IDE marker)
        {
            name: '.cursor/rules under a subdir',
            source: 'applications/foo/.cursor/rules/x.mdc',
            expected: 'applications/foo',
        },
        {
            name: '.kody/rules under a subdir',
            source: 'apps/api/.kody/rules/security.md',
            expected: 'apps/api',
        },
        {
            name: '.cursorrules under a subdir',
            source: 'applications/bar/.cursorrules',
            expected: 'applications/bar',
        },
        {
            name: 'CLAUDE.md under a subdir',
            source: 'applications/baz/CLAUDE.md',
            expected: 'applications/baz',
        },
        {
            name: 'docs/coding-standards under a deep subdir',
            source: 'monorepo/web/docs/coding-standards/typescript.md',
            expected: 'monorepo/web',
        },
        // Edge cases
        {
            name: 'empty string',
            source: '',
            expected: null,
        },
    ];

    for (const c of cases) {
        it(c.name, () => {
            expect(extractRepoSubdirFromIdeSource(c.source)).toBe(c.expected);
        });
    }
});

describe('isIdeRuleSource — sanity check', () => {
    it('returns true for known patterns at root and under subdirs', () => {
        expect(isIdeRuleSource('.cursorrules')).toBe(true);
        expect(isIdeRuleSource('apps/web/.cursorrules')).toBe(true);
        expect(isIdeRuleSource('.cursor/rules/foo.mdc')).toBe(true);
        expect(isIdeRuleSource('CLAUDE.md')).toBe(true);
    });

    it('returns false for unrelated source files', () => {
        expect(isIdeRuleSource('package.json')).toBe(false);
        expect(isIdeRuleSource('apps/web/tsconfig.json')).toBe(false);
        expect(isIdeRuleSource(null)).toBe(false);
        expect(isIdeRuleSource(undefined)).toBe(false);
        expect(isIdeRuleSource('')).toBe(false);
    });
});

describe('pathMatchesIdeRuleDir', () => {
    const IDE_PATHS = [
        '.cursor/rules/**/*',
        '.cursor/rules/**',
        '.kody/rules/**',
        '.github/instructions/**',
        '.sourcegraph/**/*.rule.md',
        'applications/foo/.cursor/rules/**/*',
    ];

    for (const p of IDE_PATHS) {
        it(`flags "${p}" as IDE rule dir`, () => {
            expect(pathMatchesIdeRuleDir(p)).toBe(true);
        });
    }

    const REAL_CODE_PATHS = [
        '**/*',
        'src/**/*.ts',
        '**/*.controller.ts,**/*.service.ts',
        'apps/web/**',
        'esbuild.config.js',
    ];

    for (const p of REAL_CODE_PATHS) {
        it(`does NOT flag "${p}"`, () => {
            expect(pathMatchesIdeRuleDir(p)).toBe(false);
        });
    }

    it('flags any glob in a comma-separated list that hits an IDE dir', () => {
        // Defensive: even if the LLM slips an IDE glob into a list of
        // otherwise legit globs, we want to catch it.
        expect(
            pathMatchesIdeRuleDir('src/**/*.ts,.cursor/rules/**/*'),
        ).toBe(true);
    });

    it('returns false for empty / nullish input', () => {
        expect(pathMatchesIdeRuleDir('')).toBe(false);
        expect(pathMatchesIdeRuleDir(null)).toBe(false);
        expect(pathMatchesIdeRuleDir(undefined)).toBe(false);
    });
});

describe('validateAndScopeIdeRulePath', () => {
    it('accepts an explicit non-** glob declared by the LLM', () => {
        const result = validateAndScopeIdeRulePath({
            llmPath: 'src/**/*.ts',
            sourceFilePath: '.cursor/rules/security.mdc',
            pathSource: 'declared',
        });
        expect(result.path).toBe('src/**/*.ts');
        expect(result.reason).toBe('accepted-as-is');
    });

    it('does NOT scope a "**/*" glob that the LLM marked as declared', () => {
        // User explicitly wrote "globs: **/*" in the MDC; respect it.
        const result = validateAndScopeIdeRulePath({
            llmPath: '**/*',
            sourceFilePath: 'applications/foo/.cursor/rules/x.mdc',
            pathSource: 'declared',
        });
        expect(result.path).toBe('**/*');
        expect(result.reason).toBe('accepted-as-is');
    });

    it('scopes "**/*" inferred glob to the repo subdir of the source', () => {
        const result = validateAndScopeIdeRulePath({
            llmPath: '**/*',
            sourceFilePath: 'applications/foo/.cursor/rules/x.mdc',
            pathSource: 'default-repo-wide',
        });
        expect(result.path).toBe('applications/foo/**/*');
        expect(result.reason).toBe('accepted-scoped');
    });

    it('keeps "**/*" inferred glob repo-wide when source is at the repo root', () => {
        // No subdir to scope to → the glob is unchanged. Mark as
        // accepted-as-is, not accepted-scoped, so telemetry can tell
        // the difference.
        const result = validateAndScopeIdeRulePath({
            llmPath: '**/*',
            sourceFilePath: '.cursor/rules/x.mdc',
            pathSource: 'default-repo-wide',
        });
        expect(result.path).toBe('**/*');
        expect(result.reason).toBe('accepted-as-is');
    });

    it('rejects a path that points at the IDE rule dir and rebuilds from source location', () => {
        // REGRESSION: this is the v2 bug — LLM (or a previous backend
        // version) emitted ".cursor/rules/**/*" as the path, which would
        // tell the reviewer to lint the rule files themselves.
        const result = validateAndScopeIdeRulePath({
            llmPath: '.cursor/rules/**/*',
            sourceFilePath: 'applications/foo/.cursor/rules/x.mdc',
            pathSource: 'declared',
        });
        expect(result.path).toBe('applications/foo/**/*');
        expect(result.reason).toBe('rejected-ide-path');
        expect(result.originalLlmPath).toBe('.cursor/rules/**/*');
    });

    it('rejects empty / missing path and rebuilds from source location', () => {
        const result = validateAndScopeIdeRulePath({
            llmPath: '',
            sourceFilePath: 'applications/foo/.cursor/rules/x.mdc',
            pathSource: 'default-repo-wide',
        });
        expect(result.path).toBe('applications/foo/**/*');
        expect(result.reason).toBe('rejected-empty');
    });

    it('rejects an LLM path that echoes the source file path verbatim', () => {
        // Failure mode: LLM (or fallback) returned the source path as
        // the rule path. Visible in production (rule "Externalize vscode"
        // had path === sourcePath === "esbuild.config.js" — borderline,
        // but still wrong shape).
        const result = validateAndScopeIdeRulePath({
            llmPath: 'apps/web/.cursorrules',
            sourceFilePath: 'apps/web/.cursorrules',
            pathSource: 'declared',
        });
        expect(result.path).toBe('apps/web/**/*');
        expect(result.reason).toBe('rejected-empty');
    });

    it('rejects null / undefined path and rebuilds repo-wide for root sources', () => {
        const result = validateAndScopeIdeRulePath({
            llmPath: null as any,
            sourceFilePath: '.cursorrules',
            pathSource: undefined,
        });
        expect(result.path).toBe('**/*');
        expect(result.reason).toBe('rejected-empty');
    });

    it('respects an explicit non-** glob even when pathSource is missing', () => {
        // Backward compat: prompts that don't ask for pathSource still
        // get sane behaviour as long as the path itself is reasonable.
        const result = validateAndScopeIdeRulePath({
            llmPath: 'apps/web/**/*.tsx',
            sourceFilePath: 'apps/web/.cursor/rules/x.mdc',
            pathSource: undefined,
        });
        expect(result.path).toBe('apps/web/**/*.tsx');
        expect(result.reason).toBe('accepted-as-is');
    });

    it('rejects David-case: path === sourcePath where sourcePath itself is a glob', () => {
        // Real bug from production: rules persisted with
        //   sourcePath: "src/**/*.ts"
        //   path:       "src/**/*.ts"
        // because the LLM (or the legacy fallback) copied sourcePath into
        // path. The validator must catch this. Because `sourcePath` is
        // itself a glob (legacy row), we can't recover a meaningful subdir
        // from it — fall back repo-wide.
        const result = validateAndScopeIdeRulePath({
            llmPath: 'src/**/*.ts',
            sourceFilePath: 'src/**/*.ts',
            pathSource: undefined,
        });
        expect(result.path).toBe('**/*');
        expect(result.reason).toBe('rejected-empty');
    });

    it('handles whitespace around an otherwise-valid glob', () => {
        // The validator currently does not trim, but this guards against
        // accidental change. If someone later decides to trim, the test
        // tells them the call sites that depend on this behaviour.
        const result = validateAndScopeIdeRulePath({
            llmPath: '  src/**/*.ts  ',
            sourceFilePath: '.cursor/rules/foo.mdc',
            pathSource: 'declared',
        });
        expect(result.path).toBe('  src/**/*.ts  ');
        expect(result.reason).toBe('accepted-as-is');
    });
});
