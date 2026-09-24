import { PromptContextEngineService } from './promptContextEngine.service';
import { PromptSourceType } from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';

/**
 * Mutation-killing unit tests for the deterministic logic of
 * PromptContextEngineService.
 *
 * `buildSearchPatterns` touches none of the injected dependencies, and
 * `buildRequirement` only calls referenceDetectorService.extractMCPDependencies.
 * We therefore construct the service with inert stubs and reach the private
 * methods via `(service as any)`.
 */
describe('PromptContextEngineService (deterministic logic)', () => {
    let extractMCPDependencies: jest.Mock;
    let service: PromptContextEngineService;
    const asAny = () => service as any;

    beforeEach(() => {
        extractMCPDependencies = jest.fn().mockReturnValue([]);
        service = new PromptContextEngineService(
            {} as any,
            {} as any,
            { extractMCPDependencies } as any,
        );
    });

    describe('buildSearchPatterns', () => {
        it('prepends filePattern as the first candidate when present', () => {
            const patterns = asAny().buildSearchPatterns({
                fileName: 'config.yml',
                filePattern: 'src/**/config.yml',
            });

            expect(patterns).toEqual([
                'src/**/config.yml',
                '**/config.yml',
                '**/CONFIG.YML',
                '**/Config.yml',
            ]);
        });

        it('omits the filePattern slot entirely when filePattern is absent', () => {
            const patterns = asAny().buildSearchPatterns({
                fileName: 'config.yml',
            });

            // Same as above minus the leading filePattern entry: proves the
            // `if (ref.filePattern)` guard is honoured (not always-push).
            expect(patterns).toEqual([
                '**/config.yml',
                '**/CONFIG.YML',
                '**/Config.yml',
            ]);
        });

        it('skips the lowercase variant when fileName is already lowercase', () => {
            const patterns = asAny().buildSearchPatterns({
                fileName: 'config.yml',
            });

            // lowerFileName === fileName, so no extra '**/config.yml' is added,
            // while the uppercase and capitalized variants still appear.
            expect(patterns).toEqual([
                '**/config.yml',
                '**/CONFIG.YML',
                '**/Config.yml',
            ]);
        });

        it('skips the uppercase variant when fileName is already uppercase', () => {
            const patterns = asAny().buildSearchPatterns({
                fileName: 'README.MD',
            });

            // upperFileName === fileName -> no uppercase push; lowercase and
            // capitalized variants are still produced.
            expect(patterns).toEqual([
                '**/README.MD',
                '**/readme.md',
                '**/Readme.md',
            ]);
        });

        it('emits lower, upper and capitalized variants for a mixed-case name with extension', () => {
            const patterns = asAny().buildSearchPatterns({
                fileName: 'ReadMe.md',
            });

            expect(patterns).toEqual([
                '**/ReadMe.md',
                '**/readme.md',
                '**/README.MD',
                '**/Readme.md',
            ]);
        });

        it('skips the capitalized variant when it equals the uppercase variant (single lowercase char, no extension)', () => {
            const patterns = asAny().buildSearchPatterns({
                fileName: 'a',
            });

            // lower === fileName (skip lower); upper 'A' pushed; capitalized 'A'
            // === upper so the capitalized guard skips it. No '.', so .md
            // variants for a/A are added and deduped.
            expect(patterns).toEqual(['**/a', '**/A', '**/a.md', '**/A.md']);
        });

        it('skips the capitalized variant when it equals the original fileName', () => {
            const patterns = asAny().buildSearchPatterns({
                fileName: 'Readme',
            });

            // capitalizedFileName ('Readme') === fileName -> capitalized push
            // skipped. Extensionless, so .md variants for each distinct form.
            expect(patterns).toEqual([
                '**/Readme',
                '**/readme',
                '**/README',
                '**/Readme.md',
                '**/README.md',
                '**/readme.md',
            ]);
        });

        it('adds markdown fallbacks for an extensionless name and dedupes (first-wins)', () => {
            const patterns = asAny().buildSearchPatterns({
                fileName: 'README',
            });

            // fileName='README' (no dot) triggers the .md branch:
            //   base: README (fileName), readme (lower), Readme (capitalized)
            //         (upper 'README' === fileName so no upper push)
            //   .md:  README.md (fileName), README.md (upper, deduped),
            //         readme.md (lower), Readme.md (capitalized)
            expect(patterns).toEqual([
                '**/README',
                '**/readme',
                '**/Readme',
                '**/README.md',
                '**/readme.md',
                '**/Readme.md',
            ]);
        });

        it('does NOT add markdown fallbacks when the name has an extension', () => {
            const patterns = asAny().buildSearchPatterns({
                fileName: 'notes.txt',
            });

            expect(patterns).toEqual([
                '**/notes.txt',
                '**/NOTES.TXT',
                '**/Notes.txt',
            ]);
            expect(patterns.some((p: string) => p.endsWith('.md'))).toBe(false);
        });
    });

    describe('buildRequirement', () => {
        const baseParams = () => ({
            requirementId: 'req-1',
            promptText: 'see the README',
            path: ['a', 'b'],
            sourceType: PromptSourceType.CUSTOM_INSTRUCTION,
            repositoryId: 'param-repo-id',
            repositoryName: 'param-repo-name',
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        });

        it('sets domain, taskIntent, consumer and top-level scalar fields exactly', () => {
            const result = asAny().buildRequirement({
                params: baseParams(),
                references: [],
                syncErrors: [],
                markers: ['@marker'],
                promptHash: 'hash-123',
            });

            expect(result.id).toBe('req-1');
            expect(result.consumer).toEqual({
                id: 'req-1',
                kind: 'prompt_section',
                name: PromptSourceType.CUSTOM_INSTRUCTION,
                metadata: {
                    path: ['a', 'b'],
                    sourceType: PromptSourceType.CUSTOM_INSTRUCTION,
                },
            });
            expect(result.request).toEqual({
                domain: 'code',
                taskIntent: 'review',
                signal: {
                    metadata: {
                        path: ['a', 'b'],
                        sourceType: PromptSourceType.CUSTOM_INSTRUCTION,
                    },
                },
            });
            expect(result.metadata).toEqual({
                path: ['a', 'b'],
                sourceType: PromptSourceType.CUSTOM_INSTRUCTION,
                inlineMarkers: ['@marker'],
                syncErrors: [],
                promptHash: 'hash-123',
            });
        });

        it('marks status "active" when there are zero sync errors', () => {
            const result = asAny().buildRequirement({
                params: baseParams(),
                references: [],
                syncErrors: [],
                markers: [],
                promptHash: 'h',
            });

            expect(result.status).toBe('active');
        });

        it('marks status "draft" when there is at least one sync error (boundary 0 vs 1)', () => {
            const result = asAny().buildRequirement({
                params: baseParams(),
                references: [],
                syncErrors: [{ type: 'x', message: 'm' } as any],
                markers: [],
                promptHash: 'h',
            });

            expect(result.status).toBe('draft');
        });

        it('falls back to params.repositoryName/repositoryId when the reference omits them', () => {
            const result = asAny().buildRequirement({
                params: baseParams(),
                references: [
                    {
                        filePath: 'docs/README.md',
                        description: 'the readme',
                        originalText: 'see the README',
                        // no repositoryName, no repositoryId, no lineRange
                    },
                ],
                syncErrors: [],
                markers: [],
                promptHash: 'h',
            });

            expect(result.dependencies).toHaveLength(1);
            const dep = result.dependencies[0];
            expect(dep.type).toBe('knowledge');
            expect(dep.id).toBe('param-repo-name|docs/README.md|0');
            expect(dep.metadata).toEqual({
                repositoryId: 'param-repo-id',
                repositoryName: 'param-repo-name',
                filePath: 'docs/README.md',
                lineRange: null,
                description: 'the readme',
                originalText: 'see the README',
                detectedAt: expect.any(String),
            });
        });

        it('uses the reference-supplied repositoryName/repositoryId/lineRange when present', () => {
            const lineRange = { start: 10, end: 20 };
            const result = asAny().buildRequirement({
                params: baseParams(),
                references: [
                    {
                        filePath: 'lib/x.ts',
                        repositoryName: 'other-repo',
                        repositoryId: 'other-repo-id',
                        lineRange,
                        description: 'd',
                        originalText: 'o',
                    },
                ],
                syncErrors: [],
                markers: [],
                promptHash: 'h',
            });

            const dep = result.dependencies[0];
            expect(dep.id).toBe('other-repo|lib/x.ts|0');
            expect(dep.metadata.repositoryId).toBe('other-repo-id');
            expect(dep.metadata.repositoryName).toBe('other-repo');
            expect(dep.metadata.lineRange).toEqual(lineRange);
        });

        it('encodes the array index into each dependency id, preserving order', () => {
            const result = asAny().buildRequirement({
                params: baseParams(),
                references: [
                    { filePath: 'first.md', repositoryName: 'r' },
                    { filePath: 'second.md', repositoryName: 'r' },
                ],
                syncErrors: [],
                markers: [],
                promptHash: 'h',
            });

            expect(result.dependencies.map((d: any) => d.id)).toEqual([
                'r|first.md|0',
                'r|second.md|1',
            ]);
        });

        it('appends MCP dependencies after the file dependencies', () => {
            extractMCPDependencies.mockReturnValue([
                { type: 'mcp', id: 'mcp-tool-1' },
            ]);

            const params = baseParams();
            const result = asAny().buildRequirement({
                params,
                references: [{ filePath: 'a.md', repositoryName: 'r' }],
                syncErrors: [],
                markers: [],
                promptHash: 'h',
            });

            expect(extractMCPDependencies).toHaveBeenCalledWith(
                params.promptText,
                params.repositoryId,
            );
            expect(result.dependencies.map((d: any) => d.id)).toEqual([
                'r|a.md|0',
                'mcp-tool-1',
            ]);
            expect(result.dependencies[1].type).toBe('mcp');
        });
    });
});
