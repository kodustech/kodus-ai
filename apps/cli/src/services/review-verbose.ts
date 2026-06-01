import type { FileContent, ReviewConfig } from '../types/review.js';

export function createAnalyzeStartVerboseMessages({
    diff,
    rulesOnly,
    fast,
}: {
    diff: string;
    rulesOnly?: boolean;
    fast?: boolean;
}): string[] {
    return [
        `[verbose] Review config: rulesOnly=${!!rulesOnly}, fast=${!!fast}`,
        `[verbose] Diff size: ${diff.length} characters`,
    ];
}

export function createFullFileContentsVerboseMessages(
    files: FileContent[] | undefined,
): string[] {
    const safeFiles = files ?? [];
    return [
        `[verbose] Full file contents: ${safeFiles.length} file(s)`,
        ...safeFiles.map(
            (file) =>
                `[verbose]   - ${file.path}: ${file.content.length} chars, status=${file.status}`,
        ),
    ];
}

export function createAnalyzeApiRequestVerboseMessages({
    diff,
    reviewConfig,
    mode,
    gitInfo,
}: {
    diff: string;
    reviewConfig: ReviewConfig;
    mode: 'team-key' | 'personal-token';
    gitInfo?: { branch?: string; remote?: string | null };
}): string[] {
    const lines =
        mode === 'team-key'
            ? [
                  '[verbose] Using team key with metrics',
                  `[verbose] Git info: branch=${gitInfo?.branch ?? ''}, remote=${gitInfo?.remote ?? ''}`,
              ]
            : ['[verbose] Using personal token (no metrics)'];

    return [
        ...lines,
        '[verbose] Sending to API:',
        `[verbose]   - diff length: ${diff.length} chars`,
        `[verbose]   - config: ${JSON.stringify(reviewConfig)}`,
    ];
}

export function createAnalyzeApiResponseVerboseMessages({
    summary,
    issuesCount,
    filesAnalyzed,
}: {
    summary: string;
    issuesCount: number;
    filesAnalyzed: number;
}): string[] {
    return [
        '[verbose] API response:',
        `[verbose]   - summary: ${summary}`,
        `[verbose]   - issues: ${issuesCount}`,
        `[verbose]   - filesAnalyzed: ${filesAnalyzed}`,
    ];
}

export function createTrialAnalyzeStartVerboseMessages(diff: string): string[] {
    const preview = diff.substring(0, 300);
    return [
        '[verbose] Running trial analyze',
        `[verbose] Diff size: ${diff.length} characters`,
        `[verbose] Diff preview:\n${preview}${diff.length > 300 ? '\n... (truncated)' : ''}`,
    ];
}

export function createTrialAnalyzeResponseVerboseMessages({
    summary,
    issuesCount,
    filesAnalyzed,
}: {
    summary: string;
    issuesCount: number;
    filesAnalyzed: number;
}): string[] {
    return [
        '[verbose] Trial API response:',
        `[verbose]   - summary: ${summary}`,
        `[verbose]   - issues: ${issuesCount}`,
        `[verbose]   - filesAnalyzed: ${filesAnalyzed}`,
    ];
}
