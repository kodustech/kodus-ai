import { normalizeRepoPath } from '@libs/code-review/infrastructure/agents/engine/coverage-ledger';

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
        it('rejects non-existent files', () => {
            const validFiles = buildValidFilesSet([
                'src/components/Button.tsx',
            ]);
            expect(
                matchesSuggestion(validFiles, 'src/components/Other.tsx'),
            ).toBe(false);
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

    describe('edge cases', () => {
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
    });
});
