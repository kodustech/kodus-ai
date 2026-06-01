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
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';

export interface PlaceholderContext {
    changedFiles?: FileChange[];
    codeReviewConfig?: CodeReviewConfig;
    language?: string;
    platformType?: PlatformType;
    organizationAndTeamData?: OrganizationAndTeamData;
    prNumber?: number;
}

export type PlaceholderHandler = (
    context: PlaceholderContext,
) => Promise<string> | string;

@Injectable()
export class MessageTemplateProcessor {
    private handlers = new Map<string, PlaceholderHandler>();

    constructor() {
        this.registerDefaultHandlers();
    }

    private registerDefaultHandlers(): void {
        this.handlers.set('changedFiles', this.generateChangedFilesTable);
        this.handlers.set('changeSummary', this.generateChangeSummary);
        this.handlers.set('reviewOptions', this.generateReviewOptionsAccordion);
        this.handlers.set('reviewCadence', this.generateReviewCadenceInfo);
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
            const handler = this.handlers.get(placeholder);

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
                    `Kody reviews the first push automatically, then pauses if you make ${pushes}+ pushes in ${timeWindow} minutes. Use @kody resume to continue.`;
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
}
