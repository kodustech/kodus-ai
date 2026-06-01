import { normalizeRepoPath } from './coverage-ledger';

/**
 * Reproduces the validFiles matching logic from base-code-review-agent.provider.ts:
 *
 *   const validFilesByNormalized = new Map(
 *       input.changedFiles.map((f) => [normalizeRepoPath(f.filename), f.filename]),
 *   );
 *   return !!s.relevantFile && validFilesByNormalized.has(normalizeRepoPath(s.relevantFile));
 *
 * Tests confirm that path normalization handles all 4 Git providers
 * AND that the suggestion's relevantFile is canonicalized back to the
 * provider's original path shape (so e.g. Azure keeps its leading slash).
 */

function buildValidFilesSet(filenames: string[]): Set<string> {
    return new Set(filenames.map((f) => normalizeRepoPath(f)));
}

function buildValidFilesMap(filenames: string[]): Map<string, string> {
    return new Map(filenames.map((f) => [normalizeRepoPath(f), f]));
}

function matchesSuggestion(
    validFiles: Set<string>,
    relevantFile: string | undefined,
): boolean {
    return !!relevantFile && validFiles.has(normalizeRepoPath(relevantFile));
}

function canonicalizeRelevantFile(
    validFiles: Map<string, string>,
    relevantFile: string | undefined,
): string | undefined {
    if (!relevantFile) return relevantFile;
    return validFiles.get(normalizeRepoPath(relevantFile)) ?? relevantFile;
}

describe('validFiles path matching across Git providers', () => {
    describe('GitHub', () => {
        it('matches paths without leading slash', () => {
            const validFiles = buildValidFilesSet([
                'src/components/Button.tsx',
                'src/utils/helpers.ts',
            ]);
            expect(
                matchesSuggestion(validFiles, 'src/components/Button.tsx'),
            ).toBe(true);
            expect(
                matchesSuggestion(validFiles, 'src/utils/helpers.ts'),
            ).toBe(true);
        });

        it('rejects non-existent files', () => {
            const validFiles = buildValidFilesSet([
                'src/components/Button.tsx',
            ]);
            expect(
                matchesSuggestion(validFiles, 'src/components/Other.tsx'),
            ).toBe(false);
        });
    });

    describe('GitLab', () => {
        it('matches paths without leading slash', () => {
            const validFiles = buildValidFilesSet([
                'app/models/user.rb',
                'spec/models/user_spec.rb',
            ]);
            expect(
                matchesSuggestion(validFiles, 'app/models/user.rb'),
            ).toBe(true);
        });
    });

    describe('Azure Repos', () => {
        it('matches when changedFiles have leading slash and suggestion does not', () => {
            const validFiles = buildValidFilesSet([
                '/Kodus.Api/Exceptions/ExceptionHandler.php',
                '/Kodus.Api/Entities/User.php',
            ]);
            expect(
                matchesSuggestion(
                    validFiles,
                    'Kodus.Api/Exceptions/ExceptionHandler.php',
                ),
            ).toBe(true);
            expect(
                matchesSuggestion(
                    validFiles,
                    'Kodus.Api/Entities/User.php',
                ),
            ).toBe(true);
        });

        it('matches when both have leading slash', () => {
            const validFiles = buildValidFilesSet([
                '/Kodus.Api/Exceptions/ExceptionHandler.php',
            ]);
            expect(
                matchesSuggestion(
                    validFiles,
                    '/Kodus.Api/Exceptions/ExceptionHandler.php',
                ),
            ).toBe(true);
        });

        it('matches when changedFiles have no slash but suggestion has leading slash', () => {
            const validFiles = buildValidFilesSet([
                'Kodus.Api/Exceptions/ExceptionHandler.php',
            ]);
            expect(
                matchesSuggestion(
                    validFiles,
                    '/Kodus.Api/Exceptions/ExceptionHandler.php',
                ),
            ).toBe(true);
        });

        it('matches with multiple leading slashes', () => {
            const validFiles = buildValidFilesSet([
                '///src/Program.php',
            ]);
            expect(
                matchesSuggestion(validFiles, 'src/Program.php'),
            ).toBe(true);
        });
    });

    describe('Bitbucket', () => {
        it('matches standard paths', () => {
            const validFiles = buildValidFilesSet([
                'src/main/java/com/example/App.java',
            ]);
            expect(
                matchesSuggestion(
                    validFiles,
                    'src/main/java/com/example/App.java',
                ),
            ).toBe(true);
        });
    });

    describe('edge cases', () => {
        it('rejects undefined relevantFile', () => {
            const validFiles = buildValidFilesSet(['src/file.ts']);
            expect(matchesSuggestion(validFiles, undefined)).toBe(false);
        });

        it('rejects empty string relevantFile', () => {
            const validFiles = buildValidFilesSet(['src/file.ts']);
            expect(matchesSuggestion(validFiles, '')).toBe(false);
        });

        it('normalizes backslashes to forward slashes', () => {
            const validFiles = buildValidFilesSet([
                'src\\components\\Button.tsx',
            ]);
            expect(
                matchesSuggestion(validFiles, 'src/components/Button.tsx'),
            ).toBe(true);
        });

        it('trims whitespace from paths', () => {
            const validFiles = buildValidFilesSet([
                '  src/file.ts  ',
            ]);
            expect(matchesSuggestion(validFiles, 'src/file.ts')).toBe(true);
        });

        it('handles mixed providers in the same set', () => {
            const validFiles = buildValidFilesSet([
                '/azure-style/file.php',
                'github-style/file.ts',
                'gitlab-style/file.rb',
            ]);
            expect(
                matchesSuggestion(validFiles, 'azure-style/file.php'),
            ).toBe(true);
            expect(
                matchesSuggestion(validFiles, 'github-style/file.ts'),
            ).toBe(true);
            expect(
                matchesSuggestion(validFiles, 'gitlab-style/file.rb'),
            ).toBe(true);
        });
    });

    describe('canonicalization back to provider path', () => {
        it('restores Azure leading slash from LLM-emitted path', () => {
            const validFiles = buildValidFilesMap([
                '/Kodus.Api/Exceptions/ExceptionHandler.php',
            ]);
            expect(
                canonicalizeRelevantFile(
                    validFiles,
                    'Kodus.Api/Exceptions/ExceptionHandler.php',
                ),
            ).toBe('/Kodus.Api/Exceptions/ExceptionHandler.php');
        });

        it('keeps GitHub-style path untouched', () => {
            const validFiles = buildValidFilesMap([
                'src/components/Button.tsx',
            ]);
            expect(
                canonicalizeRelevantFile(
                    validFiles,
                    'src/components/Button.tsx',
                ),
            ).toBe('src/components/Button.tsx');
        });

        it('strips an extra leading slash from the LLM when provider had none', () => {
            const validFiles = buildValidFilesMap([
                'src/components/Button.tsx',
            ]);
            expect(
                canonicalizeRelevantFile(
                    validFiles,
                    '/src/components/Button.tsx',
                ),
            ).toBe('src/components/Button.tsx');
        });

        it('normalizes backslashes back to the provider path', () => {
            const validFiles = buildValidFilesMap([
                'src/components/Button.tsx',
            ]);
            expect(
                canonicalizeRelevantFile(
                    validFiles,
                    'src\\components\\Button.tsx',
                ),
            ).toBe('src/components/Button.tsx');
        });

        it('falls back to the LLM path when no provider match exists', () => {
            const validFiles = buildValidFilesMap(['src/known.ts']);
            expect(
                canonicalizeRelevantFile(validFiles, 'src/unknown.ts'),
            ).toBe('src/unknown.ts');
        });

        it('passes undefined through unchanged for PR-level kody_rules', () => {
            const validFiles = buildValidFilesMap(['src/known.ts']);
            expect(canonicalizeRelevantFile(validFiles, undefined)).toBe(
                undefined,
            );
        });
    });
});
