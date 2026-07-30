import { KodyRulesAgentProvider } from '@libs/code-review/infrastructure/agents/providers/kody-rules-agent.provider';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

// Agent-path twin of the comma-glob bug (#1483): rule paths are persisted
// comma-joined by the repo-file importer; the agent's matcher passed the
// whole string to picomatch (comma = literal) so multi-glob rules matched
// nothing and the kody-rules agent silently reviewed without them. Caught
// live by the kody-rules-file-sync E2E on the hotfix droplet.
describe('KodyRulesAgentProvider.matchesPathPattern', () => {
    const provider = Object.create(
        KodyRulesAgentProvider.prototype,
    ) as KodyRulesAgentProvider;
    const matches = (file: string, pattern: string): boolean =>
        (provider as any).matchesPathPattern(file, pattern);

    it('matches a file against ANY comma-joined glob', () => {
        const pattern = 'src/e2e_sync/**/*.ts,lib/e2e_sync/**/*.ts';
        expect(matches('lib/e2e_sync/report.ts', pattern)).toBe(true);
        expect(matches('src/e2e_sync/a/b.ts', pattern)).toBe(true);
        expect(matches('app/other.ts', pattern)).toBe(false);
    });

    it('keeps brace alternations intact', () => {
        expect(matches('app/x.rb', '{app,lib}/**/*.rb')).toBe(true);
        expect(matches('lib/y.rb', '{app,lib}/**/*.rb')).toBe(true);
    });

    it('single glob, exact and dir-prefix still work', () => {
        expect(matches('src/foo.ts', 'src/**/*.ts')).toBe(true);
        expect(matches('src/foo.ts', 'src/foo.ts')).toBe(true);
        expect(matches('src/sub/foo.ts', 'src/')).toBe(true);
        expect(matches('other/foo.ts', 'src/**/*.ts')).toBe(false);
    });

    it('multi-glob DIRECTORY paths match files inside each directory (src/,lib/)', () => {
        // Trailing-slash globs are directories to picomatch — the prefix
        // fallback must run per split glob, not on the joined string.
        expect(matches('src/deep/file.ts', 'src/,lib/')).toBe(true);
        expect(matches('lib/x.ts', 'src/,lib/')).toBe(true);
        expect(matches('other/x.ts', 'src/,lib/')).toBe(false);
    });

    it('directory globs do NOT leak into similarly named sibling dirs', () => {
        // The trailing slash is part of the prefix — "src/" can never
        // prefix-match "src-legacy/…". Pinned because a review suggestion
        // proposed a boundary check that would have broken correct matches.
        expect(matches('src-legacy/index.ts', 'src/,lib/')).toBe(false);
        expect(matches('libx/a.ts', 'src/,lib/')).toBe(false);
        expect(matches('src/index.ts', 'src/,lib/')).toBe(true);
    });
});