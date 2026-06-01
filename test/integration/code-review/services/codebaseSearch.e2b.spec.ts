/**
 * Unit tests for CodebaseSearchService (parseGrepOutput, mergeRanges).
 *
 * These run in Jest without needing E2B.
 * For full integration tests with a real sandbox, run:
 *   npx tsx test/integration/code-review/services/codebaseSearch.e2b.ts
 */

import { CodebaseSearchService } from '@libs/code-review/infrastructure/adapters/services/codebaseSearch.service';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('CodebaseSearchService', () => {
    let service: CodebaseSearchService;

    beforeAll(() => {
        service = new CodebaseSearchService();
    });

    describe('parseGrepOutput()', () => {
        it('should parse standard rg output', () => {
            const raw = [
                'src/auth.ts:42:  const key = hash(input)',
                'src/api.ts:10:  export function hash(data: string) {',
            ].join('\n');

            const matches = service.parseGrepOutput(raw);

            expect(matches).toHaveLength(2);
            expect(matches[0]).toEqual({
                file: 'src/auth.ts',
                line: 42,
                text: '  const key = hash(input)',
            });
            expect(matches[1]).toEqual({
                file: 'src/api.ts',
                line: 10,
                text: '  export function hash(data: string) {',
            });
        });

        it('should handle lines with colons in content', () => {
            const raw =
                'src/config.ts:5:  const url = "http://localhost:3000";';

            const matches = service.parseGrepOutput(raw);

            expect(matches).toHaveLength(1);
            expect(matches[0].file).toBe('src/config.ts');
            expect(matches[0].line).toBe(5);
            expect(matches[0].text).toContain('http://localhost:3000');
        });

        it('should skip empty lines and malformed output', () => {
            const raw = [
                '',
                'src/ok.ts:1:valid line',
                'malformed-no-line-number',
                '',
                'src/ok2.ts:2:another valid',
            ].join('\n');

            const matches = service.parseGrepOutput(raw);

            expect(matches).toHaveLength(2);
            expect(matches[0].file).toBe('src/ok.ts');
            expect(matches[1].file).toBe('src/ok2.ts');
        });

        it('should return empty array for empty input', () => {
            expect(service.parseGrepOutput('')).toEqual([]);
            expect(service.parseGrepOutput('  \n  ')).toEqual([]);
        });
    });

    describe('mergeRanges()', () => {
        it('should merge adjacent matches within gap', () => {
            const grouped = new Map([
                [
                    'file.ts',
                    [
                        { file: 'file.ts', line: 10, text: 'a' },
                        { file: 'file.ts', line: 12, text: 'b' },
                        { file: 'file.ts', line: 15, text: 'c' },
                    ],
                ],
            ]);

            const ranges = service.mergeRanges(grouped);

            expect(ranges.get('file.ts')).toEqual([[10, 15]]);
        });

        it('should keep distant matches as separate ranges', () => {
            const grouped = new Map([
                [
                    'file.ts',
                    [
                        { file: 'file.ts', line: 10, text: 'a' },
                        { file: 'file.ts', line: 100, text: 'b' },
                    ],
                ],
            ]);

            const ranges = service.mergeRanges(grouped);

            expect(ranges.get('file.ts')).toEqual([
                [10, 10],
                [100, 100],
            ]);
        });

        it('should handle multiple files independently', () => {
            const grouped = new Map([
                ['a.ts', [{ file: 'a.ts', line: 5, text: 'x' }]],
                ['b.ts', [{ file: 'b.ts', line: 20, text: 'y' }]],
            ]);

            const ranges = service.mergeRanges(grouped);

            expect(ranges.get('a.ts')).toEqual([[5, 5]]);
            expect(ranges.get('b.ts')).toEqual([[20, 20]]);
        });
    });

    describe('matchesExclude()', () => {
        const matchesExclude = (filePath: string, exclude: string) =>
            (service as any).matchesExclude(filePath, exclude);

        it('should match directory segments exactly', () => {
            expect(matchesExclude('src/test/foo.ts', 'test')).toBe(true);
            expect(matchesExclude('test/foo.ts', 'test')).toBe(true);
            expect(
                matchesExclude('node_modules/lib/a.ts', 'node_modules'),
            ).toBe(true);
        });

        it('should NOT match partial directory names (no substring)', () => {
            expect(matchesExclude('src/attest.ts', 'test')).toBe(false);
            expect(matchesExclude('src/testing-utils.ts', 'test')).toBe(false);
            expect(matchesExclude('src/contest/a.ts', 'test')).toBe(false);
        });

        it('should match extension globs', () => {
            expect(matchesExclude('lib/bundle.min.js', '*.min.js')).toBe(true);
            expect(matchesExclude('dist/app.map', '*.map')).toBe(true);
            expect(matchesExclude('src/utils.ts', '*.min.js')).toBe(false);
        });

        it('should match path prefixes with trailing slash', () => {
            expect(matchesExclude('test/unit/foo.ts', 'test/')).toBe(true);
            expect(matchesExclude('src/test/foo.ts', 'test/')).toBe(false);
        });
    });

    describe('search()', () => {
        it('should return error for empty query', async () => {
            const result = await service.search({
                query: '',
                remoteCommands: {
                    grep: jest.fn(),
                    read: jest.fn(),
                    listDir: jest.fn(),
                },
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe('Empty query');
        });

        it('should return empty contexts when grep finds no matches', async () => {
            const result = await service.search({
                query: 'nonexistent',
                remoteCommands: {
                    grep: jest.fn().mockRejectedValue(new Error('exit code 1')),
                    read: jest.fn(),
                    listDir: jest.fn(),
                },
            });

            expect(result.success).toBe(true);
            expect(result.contexts).toEqual([]);
        });

        // ─── Bug C1 regression: silent failure on auth/fatal errors ──────────
        // The E2B sandbox layer sometimes swallows non-zero exit codes
        // (git auth failures, fatal errors) and returns stderr as the resolved
        // grep value instead of throwing. When that happens, the raw string
        // contains "fatal: Authentication failed" / "exit code 128" / etc.
        // Previously the service happily passed that to parseGrepOutput,
        // which found no file:line:text matches, so the caller saw
        // `{ success: true, contexts: [] }` — a silent failure that corrupts
        // downstream LLM reviews (empty context → bad review).
        describe('Bug C1 — silent failure on auth/fatal errors', () => {
            it('fails when grep resolves with "fatal: Authentication failed" text', async () => {
                const mockGrep = jest
                    .fn()
                    .mockResolvedValue(
                        "fatal: Authentication failed for 'https://github.com/acme/secret.git'",
                    );

                const result = await service.search({
                    query: 'anything',
                    remoteCommands: {
                        grep: mockGrep,
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                });

                expect(result.success).toBe(false);
                expect(result.error).toMatch(/auth|fatal/i);
                expect(result.contexts).toEqual([]);
            });

            it('fails when grep resolves with "exit code 128" text', async () => {
                const mockGrep = jest
                    .fn()
                    .mockResolvedValue(
                        'Error: command exited with exit code 128',
                    );

                const result = await service.search({
                    query: 'anything',
                    remoteCommands: {
                        grep: mockGrep,
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                });

                expect(result.success).toBe(false);
                expect(result.error).toMatch(/128|fatal|auth/i);
                expect(result.contexts).toEqual([]);
            });

            it('fails when grep resolves with "could not read Username" (git prompt failure)', async () => {
                const mockGrep = jest
                    .fn()
                    .mockResolvedValue(
                        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
                    );

                const result = await service.search({
                    query: 'anything',
                    remoteCommands: {
                        grep: mockGrep,
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                });

                expect(result.success).toBe(false);
                expect(result.contexts).toEqual([]);
            });

            it('fails when grep throws an error with exit code 128', async () => {
                const mockGrep = jest
                    .fn()
                    .mockRejectedValue(
                        new Error(
                            "Command failed with exit code 128: fatal: Authentication failed for 'https://github.com/acme/private.git'",
                        ),
                    );

                const result = await service.search({
                    query: 'anything',
                    remoteCommands: {
                        grep: mockGrep,
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                });

                expect(result.success).toBe(false);
                expect(result.error).toBeDefined();
            });

            it('does NOT confuse a real match containing the word "fatal" with a fatal error', async () => {
                // Regression: make sure we detect auth/fatal errors only when the
                // raw output is NOT a valid rg line (file:line:text format).
                const mockGrep = jest
                    .fn()
                    .mockResolvedValue(
                        'src/errors.ts:42:  throw new FatalError("Authentication failed")',
                    );
                const mockRead = jest
                    .fn()
                    .mockResolvedValue(
                        'line1\nline2\nthrow new FatalError("Authentication failed")\n',
                    );

                const result = await service.search({
                    query: 'FatalError',
                    remoteCommands: {
                        grep: mockGrep,
                        read: mockRead,
                        listDir: jest.fn(),
                    },
                });

                expect(result.success).toBe(true);
                expect(result.contexts.length).toBeGreaterThan(0);
            });
        });

        it('should parse grep output and read context', async () => {
            const mockGrep = jest
                .fn()
                .mockResolvedValue(
                    'src/utils.ts:10:export function greet(name: string) {\nsrc/utils.ts:11:  return `Hello ${name}`;\n',
                );
            const mockRead = jest
                .fn()
                .mockResolvedValue(
                    'import something;\n\nexport function greet(name: string) {\n  return `Hello ${name}`;\n}\n',
                );

            const result = await service.search({
                query: 'greet',
                remoteCommands: {
                    grep: mockGrep,
                    read: mockRead,
                    listDir: jest.fn(),
                },
                excludes: ['node_modules'],
            });

            expect(result.success).toBe(true);
            expect(result.contexts.length).toBeGreaterThan(0);
            expect(result.contexts[0].file).toBe('src/utils.ts');
            expect(mockRead).toHaveBeenCalled();
        });

        it('should apply excludes filter', async () => {
            const mockGrep = jest
                .fn()
                .mockResolvedValue(
                    'node_modules/lib/a.ts:1:match\nsrc/b.ts:1:match\n',
                );
            const mockRead = jest.fn().mockResolvedValue('content');

            const result = await service.search({
                query: 'match',
                remoteCommands: {
                    grep: mockGrep,
                    read: mockRead,
                    listDir: jest.fn(),
                },
                excludes: ['node_modules'],
            });

            expect(result.success).toBe(true);
            const files = result.contexts.map((c) => c.file);
            expect(files).not.toContain('node_modules/lib/a.ts');
        });
    });
});
