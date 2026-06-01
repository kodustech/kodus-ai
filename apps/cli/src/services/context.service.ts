import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import type { ProjectContext } from '../types/cli.js';
import { gitService } from './git.service.js';
import { cliDebug } from '../utils/logger.js';

/**
 * Context Service - Reads project context files
 * Similar to CodeRabbit CLI reading .cursorrules, claude.md, etc.
 */
type RepoRootResolver = () => Promise<string>;

export class ContextService {
    constructor(
        private readonly repoRootResolver: RepoRootResolver = async () => {
            const root = await gitService.getGitRoot();
            return root.trim();
        },
    ) {}

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    private async readFile(filePath: string): Promise<string | undefined> {
        try {
            const exists = await this.fileExists(filePath);
            if (!exists) {
                return undefined;
            }

            const content = await fs.readFile(filePath, 'utf-8');
            return content.trim();
        } catch {
            return undefined;
        }
    }

    private async getRepoRoot(): Promise<string> {
        try {
            return await this.repoRootResolver();
        } catch {
            // Fallback to current directory
            return process.cwd();
        }
    }

    async readProjectContext(
        customContextPath?: string,
    ): Promise<ProjectContext> {
        const repoRoot = await this.getRepoRoot();
        const context: ProjectContext = {};

        // Read .cursorrules
        const cursorRulesPath = path.join(repoRoot, '.cursorrules');
        context.cursorRules = await this.readFile(cursorRulesPath);

        // Read claude.md or .claude.md
        const claudeMdPath = path.join(repoRoot, 'claude.md');
        const dotClaudeMdPath = path.join(repoRoot, '.claude.md');
        context.claudeRules =
            (await this.readFile(claudeMdPath)) ||
            (await this.readFile(dotClaudeMdPath));

        // Read .kodus.md or .kodus/rules.md
        const kodusMdPath = path.join(repoRoot, '.kodus.md');
        const kodusRulesPath = path.join(repoRoot, '.kodus', 'rules.md');
        context.kodusRules =
            (await this.readFile(kodusMdPath)) ||
            (await this.readFile(kodusRulesPath));

        // Read custom context file if specified
        if (customContextPath) {
            const customPath = path.isAbsolute(customContextPath)
                ? customContextPath
                : path.join(repoRoot, customContextPath);
            context.customContext = await this.readFile(customPath);
        }

        return context;
    }

    /**
     * Formats project context for inclusion in review requests
     */
    formatContextForReview(context: ProjectContext): string {
        const parts: string[] = [];

        if (context.cursorRules) {
            parts.push('=== Cursor Rules (.cursorrules) ===');
            parts.push(context.cursorRules);
            parts.push('');
        }

        if (context.claudeRules) {
            parts.push('=== Claude Rules (claude.md) ===');
            parts.push(context.claudeRules);
            parts.push('');
        }

        if (context.kodusRules) {
            parts.push('=== Kodus Rules (.kodus.md) ===');
            parts.push(context.kodusRules);
            parts.push('');
        }

        if (context.customContext) {
            parts.push('=== Custom Context ===');
            parts.push(context.customContext);
            parts.push('');
        }

        return parts.join('\n');
    }

    /**
     * Enriches diff with project context
     */
    async enrichDiffWithContext(
        diff: string,
        customContextPath?: string,
        verbose?: boolean,
    ): Promise<string> {
        const context = await this.readProjectContext(customContextPath);
        const formattedContext = this.formatContextForReview(context);

        if (verbose) {
            const contextFiles: string[] = [];
            if (context.cursorRules) {
                contextFiles.push('.cursorrules');
            }
            if (context.claudeRules) {
                contextFiles.push('claude.md');
            }
            if (context.kodusRules) {
                contextFiles.push('.kodus.md');
            }
            if (context.customContext) {
                contextFiles.push('custom context file');
            }

            if (contextFiles.length > 0) {
                cliDebug(
                    chalk.dim(
                        `[verbose] Found context files: ${contextFiles.join(', ')}`,
                    ),
                );
                cliDebug(
                    chalk.dim(
                        `[verbose] Total context size: ${formattedContext.length} characters`,
                    ),
                );
            } else {
                cliDebug(chalk.dim('[verbose] No context files found'));
            }
        }

        if (!formattedContext) {
            return diff;
        }

        return `${formattedContext}\n=== Code Changes ===\n${diff}`;
    }
}

export const contextService = new ContextService();
