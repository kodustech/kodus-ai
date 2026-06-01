import { select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import type { ReviewIssue, ReviewResult } from '../types/review.js';
import { fixService } from '../services/fix.service.js';
import { copyTextToClipboard } from '../utils/clipboard.js';
import {
    generateFixPrompt,
    generateFixPromptAll,
    getQuickFixEmptyMessage,
    groupIssuesByFile,
} from './interactive-helpers.js';
import {
    formatFileChoice,
} from './interactive-formatters.js';
import {
    renderFileHeaderLines,
    renderFixPreviewLines,
    renderIssueDetailsLines,
    renderReviewSummaryLines,
} from './interactive-renderers.js';

/**
 * Interactive UI - Navigable interface for reviewing issues
 */
class InteractiveUI {
    private displayIssueDetails(issue: ReviewIssue): void {
        renderIssueDetailsLines(issue).forEach((line) => console.log(line));
    }

    private async showFixPreview(issue: ReviewIssue): Promise<void> {
        renderFixPreviewLines(issue).forEach((line) => console.log(line));
    }

    async run(result: ReviewResult): Promise<void> {
        console.log('');
        console.log(
            chalk.bold.cyan(
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            ),
        );
        console.log(chalk.bold.cyan('  Kodus Code Review - Interactive Mode'));
        console.log(
            chalk.bold.cyan(
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            ),
        );
        console.log('');

        const summary = result.summary?.trim();
        if (summary) {
            console.log(chalk.dim('Summary: ') + chalk.white(summary));
        }
        console.log(
            chalk.dim('Files analyzed: ') +
                chalk.white(result.filesAnalyzed.toString()),
        );
        console.log(
            chalk.dim('Issues found: ') +
                chalk.white(result.issues.length.toString()),
        );
        console.log(
            chalk.dim('Duration: ') + chalk.white(`${result.duration}ms`),
        );
        console.log('');

        if (result.issues.length === 0) {
            if (!summary) {
                console.log(
                    chalk.green.bold(
                        '✓ No issues found! Your code looks great.',
                    ),
                );
            }
            console.log('');
            return;
        }

        const fixableCount = result.issues.filter((i) => i.fixable).length;
        if (fixableCount > 0) {
            console.log(
                chalk.green(
                    `${fixableCount} issue${fixableCount > 1 ? 's' : ''} can be auto-fixed`,
                ),
            );
            console.log('');
        }

        // Group issues by file
        const issuesByFile = groupIssuesByFile(result.issues);
        const fixedIssues: ReviewIssue[] = [];
        while (true) {
            // Show file selection menu
            console.log(chalk.bold('\n📁 Select a file to review:\n'));

            const fileChoices = Array.from(issuesByFile.entries()).map(
                ([file, issues]) => ({
                    name: formatFileChoice(file, issues),
                    value: file,
                }),
            );

            const remainingIssueCount = Array.from(
                issuesByFile.values(),
            ).reduce((sum, issues) => sum + issues.length, 0);
            const remainingFileCount = issuesByFile.size;

            if (remainingFileCount > 1) {
                fileChoices.push({
                    name: chalk.cyan(
                        `📋 Copy ALL issues to AI agent (${remainingIssueCount} issues, ${remainingFileCount} files)`,
                    ),
                    value: '__COPY_ALL__',
                });
            }

            fileChoices.push({
                name: chalk.dim('Exit review'),
                value: '__EXIT__',
            });

            const selectedFile = await select({
                message: 'Choose a file:',
                choices: fileChoices,
                pageSize: 15,
            });

            if (selectedFile === '__EXIT__') {
                break;
            }

            if (selectedFile === '__COPY_ALL__') {
                await this.copyAllIssuesToClipboard(issuesByFile);
                continue;
            }

            // Show issues for selected file
            const fileIssues = issuesByFile.get(selectedFile)!;
            await this.reviewFileIssues(selectedFile, fileIssues, fixedIssues);

            // Remove file from list if all issues are fixed
            const fixedSet = new Set(fixedIssues);
            if (fileIssues.every((issue) => fixedSet.has(issue))) {
                issuesByFile.delete(selectedFile);

                if (issuesByFile.size === 0) {
                    console.log(
                        chalk.green.bold('\n✓ All issues have been fixed!'),
                    );
                    break;
                }
            }
        }

        renderReviewSummaryLines(result, fixedIssues.length).forEach((line) =>
            console.log(line),
        );
    }

    private async copyToClipboard(text: string): Promise<boolean> {
        return copyTextToClipboard(text);
    }

    /**
     * Bundle every remaining file/issue into a single prompt and copy it to
     * the clipboard so the user can paste the whole review into an AI agent
     * in one go. Falls back to printing the prompt to stdout when the
     * clipboard isn't available (SSH, container without xclip, etc.).
     */
    private async copyAllIssuesToClipboard(
        issuesByFile: Map<string, ReviewIssue[]>,
    ): Promise<void> {
        const prompt = generateFixPromptAll(issuesByFile);

        // Soft warning for very large prompts: most agents accept >100KB
        // pastes but some IDEs / chat boxes truncate, and the user should
        // know before they paste blindly.
        const SIZE_WARN_THRESHOLD = 50_000;
        if (prompt.length > SIZE_WARN_THRESHOLD) {
            console.log(
                chalk.yellow(
                    `\n⚠ Large prompt (${(prompt.length / 1024).toFixed(1)} KB). Some chat UIs may truncate — consider reviewing critical files individually if the agent loses context.`,
                ),
            );
        }

        const copied = await this.copyToClipboard(prompt);

        if (copied) {
            console.log(
                chalk.green(
                    `\n✓ Copied prompt for all issues to clipboard (${(prompt.length / 1024).toFixed(1)} KB).`,
                ),
            );
            console.log(
                chalk.dim(
                    'Paste it into Claude Code, Cursor, or any AI coding assistant.\n',
                ),
            );
        } else {
            console.log(
                chalk.yellow(
                    "\n⚠ Could not copy to clipboard. Here's the prompt:\n",
                ),
            );
            console.log(chalk.cyan('─'.repeat(60)));
            console.log(prompt);
            console.log(chalk.cyan('─'.repeat(60)));
            console.log('');
        }
    }

    private async reviewFileIssues(
        file: string,
        issues: ReviewIssue[],
        fixedIssues: ReviewIssue[],
    ): Promise<void> {
        renderFileHeaderLines(file, issues.length).forEach((line) =>
            console.log(line),
        );

        // File-level menu
        const fileAction = await select({
            message: 'What would you like to do with this file?',
            choices: [
                { name: 'Review issues one by one', value: 'review' },
                { name: 'Copy fix prompt for AI agent', value: 'copy' },
                { name: 'Back to file list', value: 'back' },
            ],
        });

        if (fileAction === 'back') {
            return;
        }

        if (fileAction === 'copy') {
            const prompt = generateFixPrompt(file, issues);
            const copied = await this.copyToClipboard(prompt);

            if (copied) {
                console.log(chalk.green('\n✓ Fix prompt copied to clipboard!'));
                console.log(
                    chalk.dim(
                        'Paste it into Claude Code, Cursor, or any AI coding assistant.\n',
                    ),
                );
            } else {
                console.log(
                    chalk.yellow(
                        "\n⚠ Could not copy to clipboard. Here's the prompt:\n",
                    ),
                );
                console.log(chalk.cyan('─'.repeat(60)));
                console.log(prompt);
                console.log(chalk.cyan('─'.repeat(60)));
                console.log('');
            }

            return;
        }

        // Review issues one by one
        for (let i = 0; i < issues.length; i++) {
            const issue = issues[i];

            // Skip if already fixed
            if (fixedIssues.includes(issue)) {
                continue;
            }

            console.log(
                chalk.bold(`\n[${i + 1}/${issues.length}] Issue in ${file}`),
            );
            this.displayIssueDetails(issue);

            const choices = [];

            if (issue.fixable) {
                choices.push(
                    { name: 'View fix preview', value: 'preview' },
                    { name: 'Apply fix', value: 'fix' },
                );
            }

            choices.push(
                { name: 'Skip this issue', value: 'skip' },
                { name: 'Back to file list', value: 'back' },
            );

            const action = await select({
                message: 'What would you like to do?',
                choices,
            });

            if (action === 'preview') {
                await this.showFixPreview(issue);
                i--; // Repeat this issue
                continue;
            }

            if (action === 'fix') {
                try {
                    await fixService.applyFix(issue);
                    console.log(chalk.green('✓ Fix applied successfully!'));
                    fixedIssues.push(issue);
                } catch (error) {
                    console.log(chalk.red('✗ Failed to apply fix'));
                    if (error instanceof Error) {
                        console.log(chalk.red(`  ${error.message}`));
                    }
                }
            }

            if (action === 'back') {
                return;
            }
        }
    }

    /**
     * Quick fix mode - applies all fixable issues automatically
     */
    async runQuickFix(result: ReviewResult): Promise<void> {
        const fixableIssues = result.issues.filter((i) => i.fixable);

        if (fixableIssues.length === 0) {
            console.log(chalk.yellow(getQuickFixEmptyMessage()));
            return;
        }

        console.log('');
        console.log(
            chalk.bold(
                `Found ${fixableIssues.length} fixable issue${fixableIssues.length > 1 ? 's' : ''}`,
            ),
        );
        console.log('');

        const confirmApply = await confirm({
            message: `Apply all ${fixableIssues.length} fixes?`,
            default: false,
        });

        if (!confirmApply) {
            console.log(chalk.yellow('Fixes cancelled'));
            return;
        }

        console.log('');
        const { applied, failed } = await fixService.applyFixes(fixableIssues);

        console.log('');
        console.log(
            chalk.green(`✓ Applied ${applied} fix${applied > 1 ? 'es' : ''}`),
        );

        if (failed > 0) {
            console.log(
                chalk.red(
                    `✗ Failed to apply ${failed} fix${failed > 1 ? 'es' : ''}`,
                ),
            );
        }

        console.log('');
    }
}

export const interactiveUI = new InteractiveUI();
