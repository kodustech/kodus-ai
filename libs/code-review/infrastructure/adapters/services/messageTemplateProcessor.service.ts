// services/message-template-processor.service.ts
import { Injectable } from '@nestjs/common';

import {
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
} from '@libs/common/utils/translations/translations';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import { LanguageValue } from '@libs/core/domain/enums/language-parameter.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    CodeReviewConfig,
    FileChange,
    ReviewCadenceType,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CommentResult } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';

export interface PlaceholderContext {
    changedFiles?: FileChange[];
    codeReviewConfig?: CodeReviewConfig;
    language?: string;
    platformType?: PlatformType;
    organizationAndTeamData?: OrganizationAndTeamData;
    prNumber?: number;
    lineComments?: CommentResult[];
}

/**
 * One review suggestion distilled into the fields the consolidated agent-prompt
 * block renders (see MessageTemplateProcessor.getConsolidatedLLMPromptBody).
 */
type ConsolidatedPromptEntry = {
    file: string;
    line?: number;
    prompt: string;
    improvedCode?: string;
};

export type PlaceholderHandler = (
    context: PlaceholderContext,
) => Promise<string> | string;

@Injectable()
export class MessageTemplateProcessor {
    private handlers = new Map<string, PlaceholderHandler>();

    // Deprecated placeholder names kept resolvable for backward-compat with
    // custom message templates saved before a rename. Aliases resolve to the
    // current handler but are intentionally NOT advertised by
    // getAvailablePlaceholders() so the UI only offers the current name.
    private aliases = new Map<string, string>([
        // @consolidatedLLMPrompt was renamed to @agentPrompt; old saved
        // templates must still render the consolidated block, not the literal.
        ['consolidatedLLMPrompt', 'agentPrompt'],
    ]);

    constructor() {
        this.registerDefaultHandlers();
    }

    private registerDefaultHandlers(): void {
        this.handlers.set('changedFiles', this.generateChangedFilesTable);
        this.handlers.set('changeSummary', this.generateChangeSummary);
        this.handlers.set('reviewOptions', this.generateReviewOptionsAccordion);
        this.handlers.set('reviewCadence', this.generateReviewCadenceInfo);
        this.handlers.set(
            'agentPrompt',
            async (context: PlaceholderContext) => {
                return this.getConsolidatedLLMPromptBody(
                    context.lineComments || [],
                );
            },
        );
        this.handlers.set('reviewScope', this.generateReviewScope);
    }

    /**
     * Process the template with the registered handlers
     *
     * Available placeholders:
     * @changedFiles - requires: context.changedFiles, context.language
     * @changeSummary - requires: context.changedFiles, context.language
     * @reviewOptions - requires: context.codeReviewConfig, context.language
     * @reviewCadence - requires: context.codeReviewConfig, context.language
     * @reviewScope - requires: context.codeReviewConfig
     * @agentPrompt - requires: context.lineComments
     *
     * @param template Template with @placeholders
     * @param context Context for the handlers
     * @returns Processed template with the handlers applied
     */
    async processTemplate(
        template: string,
        context: PlaceholderContext,
    ): Promise<string> {
        let processedContent = template;

        const placeholderRegex = /@(\w+)/g;
        const matches = [...template.matchAll(placeholderRegex)];

        for (const match of matches) {
            const placeholder = match[1];
            const aliasTarget = this.aliases.get(placeholder);
            const handler =
                this.handlers.get(placeholder) ??
                (aliasTarget ? this.handlers.get(aliasTarget) : undefined);

            if (handler) {
                const replacement = await handler(context);
                processedContent = processedContent.replace(
                    match[0],
                    replacement,
                );
            }
        }

        return processedContent;
    }

    // Registra novos handlers dinamicamente
    registerHandler(placeholder: string, handler: PlaceholderHandler): void {
        this.handlers.set(placeholder, handler);
    }

    // Lista handlers disponíveis
    getAvailablePlaceholders(): string[] {
        return Array.from(this.handlers.keys()).map((key) => `@${key}`);
    }

    /**
     * Generate the accordion with the changed files table
     * @requires context.changedFiles - Array of changed files
     * @requires context.language - Language for translation
     * @param context PlaceholderContext
     * @returns Markdown of the accordion with the changed files table
     */
    private generateChangedFilesTable = (
        context: PlaceholderContext,
    ): string => {
        if (!context.changedFiles?.length) return '';

        const translation = this.getTranslation(context.language);

        const filesTable = context.changedFiles
            .map(
                (file) =>
                    `| [${file.filename}](${file.blob_url}) | ${file.status} | ${file.additions} | ${file.deletions} | ${file.changes} |`,
            )
            .join('\n');

        return `
<details>
<summary>${translation.changedFiles}</summary>

| ${translation.filesTable.join(' | ')} |
|------|--------|-------------|-------------|------------|
${filesTable}
</details>`.trim();
    };

    /**
     * Generate the accordion with the change summary
     * @requires context.changedFiles - Array of changed files
     * @requires context.language - Language for translation
     * @param context PlaceholderContext
     * @returns Markdown of the accordion with the change summary
     */
    private generateChangeSummary = (context: PlaceholderContext): string => {
        if (!context.changedFiles?.length) return '';

        const translation = this.getTranslation(context.language);

        const totalFilesModified = context.changedFiles.length;
        const totalAdditions = context.changedFiles.reduce(
            (acc, file) => acc + file.additions,
            0,
        );
        const totalDeletions = context.changedFiles.reduce(
            (acc, file) => acc + file.deletions,
            0,
        );
        const totalChanges = context.changedFiles.reduce(
            (acc, file) => acc + file.changes,
            0,
        );

        return `
<details>
<summary>${translation.summary}</summary>

- **${translation.totalFiles}**: ${totalFilesModified}
- **${translation.totalAdditions}**: ${totalAdditions}
- **${translation.totalDeletions}**: ${totalDeletions}
- **${translation.totalChanges}**: ${totalChanges}
</details>`.trim();
    };

    /**
     * Generate the accordion with the review options
     * @requires context.codeReviewConfig - Review configuration
     * @param context PlaceholderContext
     * @returns Markdown of the accordion with the review options
     */
    private generateReviewOptionsAccordion = (
        context: PlaceholderContext,
    ): string => {
        if (!context.codeReviewConfig?.reviewOptions) return '';

        const language =
            context.codeReviewConfig?.languageResultPrompt ??
            LanguageValue.ENGLISH;
        const translation = getTranslationsForLanguageByCategory(
            language as LanguageValue,
            TranslationsCategory.ConfigReviewMarkdown,
        );

        if (!translation) return '';

        const defaultConfig = getDefaultKodusConfigFile();
        const defaultReviewOptions = Object.keys(
            defaultConfig?.reviewOptions || {},
        );

        const reviewOptionsMarkdown = Object.entries(
            context.codeReviewConfig.reviewOptions,
        )
            .filter(([key]) => defaultReviewOptions.includes(key))
            .map(
                ([key, value]) =>
                    `| **${key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())}** | ${
                        value ? translation.enabled : translation.disabled
                    } |`,
            )
            .join('\n');

        return `
<details>
<summary>${translation.reviewOptionsTitle}</summary>

${translation.reviewOptionsDesc}

| ${translation.tableOptions}                        | ${translation.tableEnabled} |
|-------------------------------|---------|
${reviewOptionsMarkdown}

</details>`.trim();
    };

    /**
     * Generate the review cadence information
     * @requires context.codeReviewConfig - Review configuration
     * @requires context.language - Language for translation
     * @param context PlaceholderContext
     * @returns Markdown with the review cadence information
     */
    private generateReviewCadenceInfo = (
        context: PlaceholderContext,
    ): string => {
        if (!context.codeReviewConfig?.reviewCadence) {
            return '';
        }

        const language =
            context.codeReviewConfig?.languageResultPrompt ??
            LanguageValue.ENGLISH;
        const translation = getTranslationsForLanguageByCategory(
            language as LanguageValue,
            TranslationsCategory.ReviewCadenceInfo,
        );

        if (!translation) {
            return '';
        }

        const cadenceType = context.codeReviewConfig.reviewCadence.type;
        let statusText: string;
        let description: string;

        switch (cadenceType) {
            case ReviewCadenceType.AUTOMATIC:
                statusText = translation.automaticTitle || 'Automatic Review';
                description =
                    translation.automaticDesc ||
                    'Kody will automatically review every push to this PR.';
                break;

            case ReviewCadenceType.AUTO_PAUSE: {
                statusText = translation.autoPauseTitle || 'Auto-Pause Mode';
                const timeWindow =
                    context.codeReviewConfig.reviewCadence.timeWindow || 15;
                const pushes =
                    context.codeReviewConfig.reviewCadence.pushesToTrigger || 3;
                description =
                    translation.autoPauseDesc
                        ?.replace('{timeWindow}', String(timeWindow))
                        ?.replace('{pushes}', String(pushes)) ||
                    `Kody reviews the first push automatically, then pauses if you make ${pushes}+ pushes in ${timeWindow} minutes. Use @kody start-review to continue.`;
                break;
            }

            case ReviewCadenceType.MANUAL:
                statusText = translation.manualTitle || 'Manual Review';
                description =
                    translation.manualDesc ||
                    'Kody only reviews when you request with @kody start-review command.';
                break;

            default:
                return '';
        }

        return `**${statusText}**: ${description}`;
    };

    /**
     * Generate the review scope information
     * @requires context.codeReviewConfig - Review configuration (configLevel, directoryFolders)
     * @param context PlaceholderContext
     * @returns Markdown describing which configuration scope was used for this review
     */
    private generateReviewScope = (context: PlaceholderContext): string => {
        const configLevel = context.codeReviewConfig?.configLevel;

        if (!configLevel || configLevel === ConfigLevel.GLOBAL) {
            return 'This PR was reviewed using **global** configuration.';
        }

        if (configLevel === ConfigLevel.REPOSITORY) {
            return 'This PR was reviewed using **repository** configuration.';
        }

        if (configLevel === ConfigLevel.DIRECTORY) {
            const folders = context.codeReviewConfig?.directoryFolders;

            if (!folders?.length) {
                return 'This PR was reviewed using **directory** configuration.';
            }

            const primaryPath = folders[0].path;
            const remaining = folders.length - 1;

            if (remaining === 0) {
                return `This PR was reviewed using directory configuration (\`${primaryPath}\`).`;
            }

            return `This PR was reviewed using directory configuration (\`${primaryPath}\` and ${remaining} other${remaining > 1 ? 's' : ''}).`;
        }

        return '';
    };

    private getTranslation(language?: string) {
        return getTranslationsForLanguageByCategory(
            (language as LanguageValue) ?? LanguageValue.ENGLISH,
            TranslationsCategory.PullRequestSummaryMarkdown,
        );
    }

    private extractPromptsFromComments(
        lineComments: CommentResult[],
    ): ConsolidatedPromptEntry[] {
        if (!lineComments?.length) return [];

        return lineComments.reduce<ConsolidatedPromptEntry[]>(
            (acc, { comment }) => {
                if (comment?.suggestion?.llmPrompt) {
                    acc.push({
                        file: comment.path,
                        line: comment.line,
                        prompt: comment.suggestion.llmPrompt,
                        improvedCode: comment.suggestion.improvedCode,
                    });
                }
                return acc;
            },
            [],
        );
    }

    private buildConsolidatedCommentBody(
        prompts: ConsolidatedPromptEntry[],
    ): string {
        const taskList = prompts
            .map(
                ({ file, line }) =>
                    `- ${file}${line != null ? `:${line}` : ''}`,
            )
            .join('\n');

        const tasks = prompts
            .map(({ file, line, prompt, improvedCode }, index) => {
                const location = `${file}${line != null ? `:${line}` : ''}`;

                const referenceSection = improvedCode
                    ? [
                          `Reference implementation (from code review):`,
                          ``,
                          `// ${location}`,
                          improvedCode.trim(),
                      ].join('\n')
                    : '';

                return [
                    `### [${index + 1}/${prompts.length}] ${location}`,
                    ``,
                    `Issue identified during code review:`,
                    prompt.trim(),
                    ``,
                    referenceSection,
                ]
                    .filter(Boolean)
                    .join('\n');
            })
            .join('\n\n---\n\n');

        const agentBlock = [
            `A code review identified the following issues in this pull request.`,
            `Each section describes what was found and includes a reference implementation where available.`,
            ``,
            `Files involved:`,
            taskList,
            ``,
            `---`,
            ``,
            tasks,
            ``,
            `---`,
            ``,
            `Review each issue in context, use the reference implementations as guidance, and apply fixes that are consistent with the surrounding codebase.`,
        ].join('\n');

        // The block is fenced so the user can copy it verbatim. improvedCode /
        // llmPrompt may themselves contain ``` fences; pick a backtick run
        // longer than any inside the content so the outer fence can't be closed
        // early (CommonMark fenced-code rule).
        const longestBacktickRun = Math.max(
            0,
            ...(agentBlock.match(/`+/g) ?? []).map((run) => run.length),
        );
        const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));

        return [
            `**Kody Code Review** — ${prompts.length} suggested fix${prompts.length > 1 ? 'es' : ''}.`,
            `Paste the prompt below to your agent and all review fixed at once!\n`,
            `<details>`,
            `<summary>🛠️ Open Agent Prompt</summary>`,
            ``,
            fence,
            agentBlock,
            fence,
            ``,
            `</details>`,
        ].join('\n');
    }

    public getConsolidatedLLMPromptBody(lineComments: CommentResult[]): string {
        const prompts = this.extractPromptsFromComments(lineComments);
        if (prompts.length === 0) return '';
        return this.buildConsolidatedCommentBody(prompts);
    }
}
