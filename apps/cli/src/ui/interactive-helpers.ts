import type { ReviewIssue } from '../types/review.js';

export function groupIssuesByFile(
    issues: ReviewIssue[],
): Map<string, ReviewIssue[]> {
    const grouped = new Map<string, ReviewIssue[]>();

    for (const issue of issues) {
        if (!grouped.has(issue.file)) {
            grouped.set(issue.file, []);
        }
        grouped.get(issue.file)!.push(issue);
    }

    return grouped;
}

export function getFileStats(issues: ReviewIssue[]): {
    critical: number;
    error: number;
    warning: number;
    info: number;
} {
    return {
        critical: issues.filter((i) => i.severity === 'critical').length,
        error: issues.filter((i) => i.severity === 'error').length,
        warning: issues.filter((i) => i.severity === 'warning').length,
        info: issues.filter((i) => i.severity === 'info').length,
    };
}

export function formatCategoryBadge(category: string): string {
    const categoryMap: Record<string, string> = {
        security_vulnerability: 'security',
        performance: 'perf',
        code_quality: 'quality',
        best_practices: 'practices',
        style: 'style',
        bug: 'bug',
        complexity: 'complex',
        maintainability: 'maintain',
    };
    return categoryMap[category] || category;
}

export function generateFixPrompt(
    file: string,
    issues: ReviewIssue[],
): string {
    let prompt = `Fix the following issues in ${file}:\n\n`;

    issues.forEach((issue, index) => {
        prompt += `${index + 1}. ${issue.severity.toUpperCase()} at line ${issue.line}\n`;
        prompt += `   ${issue.message}\n`;

        if (issue.suggestion) {
            prompt += `   Suggestion: ${issue.suggestion}\n`;
        }

        if (issue.recommendation) {
            prompt += `   Recommendation: ${issue.recommendation}\n`;
        }

        prompt += '\n';
    });

    prompt += `Please fix these ${issues.length} issue${issues.length > 1 ? 's' : ''} in ${file}.`;

    return prompt;
}

/**
 * Build a single AI-agent prompt covering every file/issue from the review,
 * so the user can hand the whole result to Claude Code/Cursor in one paste.
 * Format mirrors the per-file prompt but groups by file under H2-style
 * headers, which keeps the LLM's attention on one file at a time while
 * still giving it the full set in a single message.
 */
export function generateFixPromptAll(
    issuesByFile: Map<string, ReviewIssue[]>,
): string {
    const totalIssues = Array.from(issuesByFile.values()).reduce(
        (sum, issues) => sum + issues.length,
        0,
    );
    const fileCount = issuesByFile.size;

    let prompt = `Fix the following ${totalIssues} issue${totalIssues > 1 ? 's' : ''} across ${fileCount} file${fileCount > 1 ? 's' : ''}.\n\n`;
    prompt += `Work file-by-file in the order below. For each file, address every listed issue before moving on.\n\n`;

    let fileIndex = 0;
    for (const [file, issues] of issuesByFile.entries()) {
        fileIndex += 1;
        prompt += `## File ${fileIndex}/${fileCount}: ${file} (${issues.length} issue${issues.length > 1 ? 's' : ''})\n\n`;

        issues.forEach((issue, index) => {
            prompt += `${index + 1}. ${issue.severity.toUpperCase()} at line ${issue.line}\n`;
            prompt += `   ${issue.message}\n`;

            if (issue.suggestion) {
                prompt += `   Suggestion: ${issue.suggestion}\n`;
            }

            if (issue.recommendation) {
                prompt += `   Recommendation: ${issue.recommendation}\n`;
            }

            prompt += '\n';
        });
    }

    prompt += `Please apply all ${totalIssues} fix${totalIssues > 1 ? 'es' : ''} across the ${fileCount} file${fileCount > 1 ? 's' : ''} above.`;

    return prompt;
}

export function getQuickFixEmptyMessage(): string {
    return 'No auto-fixable issues found. Try `kodus review --interactive` to inspect issues or run `kodus review` to see the full report.';
}
