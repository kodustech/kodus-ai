import type { ReviewIssue, ReviewResult } from '../types/review.js';

/**
 * Prompt-only formatter - Optimized for AI agents
 * Outputs minimal, structured text that's easy to parse
 */
class PromptFormatter {
    format(result: ReviewResult): string {
        const lines: string[] = [];

        // Header
        lines.push('REVIEW_ANALYSIS_COMPLETE');
        lines.push('');

        // Stats
        lines.push(`FILES_ANALYZED: ${result.filesAnalyzed}`);
        lines.push(`ISSUES_FOUND: ${result.issues.length}`);
        lines.push(`DURATION_MS: ${result.duration}`);
        lines.push('');

        // Severity counts
        const critical = result.issues.filter(
            (i) => i.severity === 'critical',
        ).length;
        const errors = result.issues.filter(
            (i) => i.severity === 'error',
        ).length;
        const warnings = result.issues.filter(
            (i) => i.severity === 'warning',
        ).length;
        const info = result.issues.filter((i) => i.severity === 'info').length;

        lines.push('SEVERITY_BREAKDOWN:');
        lines.push(`  CRITICAL: ${critical}`);
        lines.push(`  ERROR: ${errors}`);
        lines.push(`  WARNING: ${warnings}`);
        lines.push(`  INFO: ${info}`);
        lines.push('');

        // Issues
        if (result.issues.length > 0) {
            lines.push('ISSUES:');
            lines.push('');

            result.issues.forEach((issue, idx) => {
                lines.push(this.formatIssue(issue, idx + 1));
                lines.push('');
            });
        } else {
            lines.push('NO_ISSUES_FOUND');
            lines.push('');
        }

        // Summary
        lines.push('SUMMARY:');
        lines.push(result.summary);
        lines.push('');

        // Footer
        lines.push('END_REVIEW');

        return lines.join('\n');
    }

    private formatIssue(issue: ReviewIssue, index: number): string {
        const lines: string[] = [];

        lines.push(`ISSUE_${index}:`);
        lines.push(`  file: ${issue.file}`);
        lines.push(`  line: ${issue.line}`);

        if (issue.endLine) {
            lines.push(`  end_line: ${issue.endLine}`);
        }

        lines.push(`  severity: ${issue.severity}`);

        if (issue.category) {
            lines.push(`  category: ${issue.category}`);
        }

        if (issue.ruleId) {
            lines.push(`  rule_id: ${issue.ruleId}`);
        }

        lines.push(`  message: ${issue.message}`);

        if (issue.suggestion) {
            lines.push(`  suggestion: ${issue.suggestion}`);
        }

        if (issue.recommendation) {
            lines.push(`  recommendation: ${issue.recommendation}`);
        }

        lines.push(`  fixable: ${issue.fixable || false}`);

        if (issue.fixable && issue.fix) {
            lines.push(`  fix_type: ${issue.fix.type}`);
            lines.push(`  fix_start_line: ${issue.fix.startLine}`);
            lines.push(`  fix_end_line: ${issue.fix.endLine}`);

            if (issue.fix.oldCode) {
                lines.push('  fix_old_code: |');
                issue.fix.oldCode.split('\n').forEach((line) => {
                    lines.push(`    ${line}`);
                });
            }

            lines.push('  fix_new_code: |');
            issue.fix.newCode.split('\n').forEach((line) => {
                lines.push(`    ${line}`);
            });
        }

        return lines.join('\n');
    }
}

export const promptFormatter = new PromptFormatter();
