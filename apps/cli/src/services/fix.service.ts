import fs from 'fs/promises';
import path from 'path';
import type { CodeFix, ReviewIssue } from '../types/review.js';
import { cliError } from '../utils/logger.js';

/**
 * Fix Service - Applies code fixes to files
 */
class FixService {
    /**
     * Applies a single fix to a file
     */
    async applyFix(issue: ReviewIssue): Promise<void> {
        if (!issue.fixable || !issue.fix) {
            throw new Error('Issue is not fixable');
        }

        const filePath = path.resolve(issue.file);
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        const fix = issue.fix;

        switch (fix.type) {
            case 'replace':
                await this.applyReplace(filePath, lines, fix);
                break;
            case 'insert':
                await this.applyInsert(filePath, lines, fix);
                break;
            case 'delete':
                await this.applyDelete(filePath, lines, fix);
                break;
        }
    }

    /**
     * Applies multiple fixes to files
     */
    async applyFixes(
        issues: ReviewIssue[],
    ): Promise<{ applied: number; failed: number }> {
        let applied = 0;
        let failed = 0;

        // Group fixes by file to avoid conflicts
        const fixesByFile = new Map<string, ReviewIssue[]>();

        for (const issue of issues) {
            if (issue.fixable && issue.fix) {
                const file = issue.file;
                if (!fixesByFile.has(file)) {
                    fixesByFile.set(file, []);
                }
                fixesByFile.get(file)!.push(issue);
            }
        }

        // Sort fixes by line number (descending) to avoid line number shifts
        for (const [, fileIssues] of fixesByFile.entries()) {
            fileIssues.sort((a, b) => (b.line || 0) - (a.line || 0));

            for (const issue of fileIssues) {
                try {
                    await this.applyFix(issue);
                    applied++;
                } catch (error) {
                    failed++;
                    cliError(
                        `Failed to apply fix for ${issue.file}:${issue.line}`,
                        error,
                    );
                }
            }
        }

        return { applied, failed };
    }

    /**
     * Generates a preview diff for a fix
     */
    generatePreview(issue: ReviewIssue): string {
        if (!issue.fixable || !issue.fix) {
            return 'No fix available';
        }

        const lines: string[] = [];
        const fix = issue.fix;

        lines.push(`File: ${issue.file}:${issue.line}`);
        lines.push('');

        if (fix.oldCode) {
            lines.push('- ' + fix.oldCode.split('\n').join('\n- '));
        }

        lines.push('+ ' + fix.newCode.split('\n').join('\n+ '));

        return lines.join('\n');
    }

    private async applyReplace(
        filePath: string,
        lines: string[],
        fix: CodeFix,
    ): Promise<void> {
        // Replace lines from startLine to endLine with newCode
        const newCodeLines = fix.newCode.split('\n');

        // Lines are 1-indexed, array is 0-indexed
        const startIdx = fix.startLine - 1;
        const endIdx = fix.endLine - 1;

        // Remove old lines and insert new ones
        lines.splice(startIdx, endIdx - startIdx + 1, ...newCodeLines);

        await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
    }

    private async applyInsert(
        filePath: string,
        lines: string[],
        fix: CodeFix,
    ): Promise<void> {
        const newCodeLines = fix.newCode.split('\n');
        const insertIdx = fix.startLine - 1;

        lines.splice(insertIdx, 0, ...newCodeLines);

        await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
    }

    private async applyDelete(
        filePath: string,
        lines: string[],
        fix: CodeFix,
    ): Promise<void> {
        const startIdx = fix.startLine - 1;
        const endIdx = fix.endLine - 1;

        lines.splice(startIdx, endIdx - startIdx + 1);

        await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
    }

    /**
     * Checks if a fix can be safely applied
     */
    async canApplyFix(issue: ReviewIssue): Promise<boolean> {
        if (!issue.fixable || !issue.fix) {
            return false;
        }

        try {
            const filePath = path.resolve(issue.file);
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }
}

export const fixService = new FixService();
