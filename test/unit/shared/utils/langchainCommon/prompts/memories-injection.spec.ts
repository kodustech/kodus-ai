import { prompt_codereview_cross_file_analysis } from '@/shared/utils/langchainCommon/prompts/codeReviewCrossFileAnalysis';
import { prompt_codeReviewSafeguard_system } from '@/shared/utils/langchainCommon/prompts/codeReviewSafeguard';
import { prompt_kodyrules_prlevel_analyzer } from '@/shared/utils/langchainCommon/prompts/kodyRulesPrLevel';

describe('memories injection in prompt generators and safeguards', () => {
    const memories = [
        {
            title: 'Normalize email before compare',
            rule: 'Always normalize both sides in case-insensitive email comparisons.',
            severity: 'medium',
        } as any,
    ];

    const externalReferences = [
        {
            filePath: 'docs/rules.md',
            lineRange: { start: 2, end: 8 },
            content: 'Always validate inbound payloads before processing.',
        },
    ];

    it('injects memories in cross-file analysis prompt', () => {
        const result = prompt_codereview_cross_file_analysis({
            files: [
                {
                    file: {
                        filename: 'src/a.ts',
                        codeDiff: '@@ -1,1 +1,1 @@\\n+const a = 1',
                    },
                },
            ],
            language: 'en-US',
            v2PromptOverrides: {},
            memories,
        });

        expect(result).toContain('## Memories');
        expect(result).toContain('Title: Normalize email before compare');
        expect(result).toContain(
            'Rule: Always normalize both sides in case-insensitive email comparisons.',
        );
    });

    it('injects external references in cross-file analysis prompt with standard section format', () => {
        const result = prompt_codereview_cross_file_analysis({
            files: [
                {
                    file: {
                        filename: 'src/a.ts',
                        codeDiff: '@@ -1,1 +1,1 @@\\n+const a = 1',
                    },
                },
            ],
            language: 'en-US',
            v2PromptOverrides: {},
            externalReferences,
        });

        expect(result).toContain('## External Context & Injected Knowledge');
        expect(result).toContain(
            '### Source: File - docs/rules.md (lines 2-8)',
        );
        expect(result).toContain(
            'Always validate inbound payloads before processing.',
        );
    });

    it('injects memories in code review safeguard prompt', () => {
        const result = prompt_codeReviewSafeguard_system({
            languageResultPrompt: 'en-US',
            memories,
        });

        expect(result).toContain('## Memories');
        expect(result).toContain('Title: Normalize email before compare');
        expect(result).toContain(
            'Rule: Always normalize both sides in case-insensitive email comparisons.',
        );
    });

    it('injects external references in code review safeguard prompt with standard section format', () => {
        const result = prompt_codeReviewSafeguard_system({
            languageResultPrompt: 'en-US',
            externalReferences,
        });

        expect(result).toContain('## External Context & Injected Knowledge');
        expect(result).toContain(
            '### Source: File - docs/rules.md (lines 2-8)',
        );
        expect(result).toContain(
            'Always validate inbound payloads before processing.',
        );
    });

    it('injects memories in PR-level kody rules analyzer prompt', () => {
        const result = prompt_kodyrules_prlevel_analyzer({
            pr_title: 'Test PR',
            pr_description: 'desc',
            stats: {
                total_additions: 1,
                total_deletions: 0,
                total_files: 1,
                total_lines_changed: 1,
            } as any,
            files: [
                {
                    filename: 'src/a.ts',
                    status: 'modified',
                    additions: 1,
                    deletions: 0,
                    changes: 1,
                    patch: '@@ -1,1 +1,1 @@\\n+const a = 1',
                } as any,
            ],
            rules: [],
            language: 'en-US',
            memories,
        });

        expect(result).toContain('## Memories');
        expect(result).toContain('Title: Normalize email before compare');
        expect(result).toContain(
            'Rule: Always normalize both sides in case-insensitive email comparisons.',
        );
    });

    it('injects external references in PR-level analyzer with standard section format', () => {
        const externalReferencesMap = new Map<string, any[]>([
            [
                'rule-1',
                [
                    {
                        filePath: 'docs/pr-rules.md',
                        lineRange: { start: 10, end: 12 },
                        content:
                            'PR descriptions must include motivation and scope.',
                    },
                ],
            ],
        ]);

        const result = prompt_kodyrules_prlevel_analyzer({
            pr_title: 'Test PR',
            pr_description: 'desc',
            stats: {
                total_additions: 1,
                total_deletions: 0,
                total_files: 1,
                total_lines_changed: 1,
            } as any,
            files: [
                {
                    filename: 'src/a.ts',
                    status: 'modified',
                    additions: 1,
                    deletions: 0,
                    changes: 1,
                    patch: '@@ -1,1 +1,1 @@\\n+const a = 1',
                } as any,
            ],
            rules: [{ uuid: 'rule-1', title: 'PR Rule' }],
            language: 'en-US',
            externalReferencesMap,
        });

        expect(result).toContain('## External Context & Injected Knowledge');
        expect(result).toContain('### Source: Rule References - rule-1');
        expect(result).toContain(
            '### Source: File - docs/pr-rules.md (lines 10-12)',
        );
    });
});
