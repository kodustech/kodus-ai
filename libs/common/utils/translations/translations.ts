import * as path from 'path';
import * as fs from 'fs';

import { LanguageValue } from '@libs/core/domain/enums/language-parameter.enum';

import { loadJsonFile } from '../transforms/file';

const getDictionaryPaths = (language: LanguageValue): string[] => {
    const fileName = `${language}.json`;

    return [
        path.resolve(__dirname, 'dictionaries', fileName),
        path.resolve(__dirname, '../../../../..', 'dictionaries', fileName),
        path.resolve(
            __dirname,
            '../../../../..',
            'dist',
            'dictionaries',
            fileName,
        ),
        path.resolve(process.cwd(), 'dist/dictionaries', fileName),
        path.resolve(
            process.cwd(),
            'libs/common/utils/translations/dictionaries',
            fileName,
        ),
    ];
};

const findDictionaryPath = (language: LanguageValue): string | null => {
    for (const candidate of getDictionaryPaths(language)) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
};

const getTranslationsForLanguage = (
    language: LanguageValue,
): Translations | null => {
    try {
        const dictionaryPath = findDictionaryPath(language);
        if (!dictionaryPath) {
            throw new Error(`Translation file not found for ${language}`);
        }

        return loadJsonFile(dictionaryPath);
    } catch (error) {
        console.error(
            `Translation file for language "${language}" not found. Falling back to en-US.`,
        );
        const dictionaryPath = findDictionaryPath(LanguageValue.ENGLISH);
        if (!dictionaryPath) {
            throw new Error('Fallback translation file not found for en-US', {
                cause: error,
            });
        }

        return loadJsonFile(dictionaryPath);
    }
};

const getTranslationsForLanguageByCategory = <T extends keyof Translations>(
    language: LanguageValue,
    category: T,
): Translations[T] | null => {
    try {
        const translations = getTranslationsForLanguage(language);
        return translations[category];
    } catch (error) {
        console.error(
            `Failed to load translations for language "${language}" or category "${category}".`,
            error,
        );
        throw error;
    }
};

interface ReviewComment {
    talkToKody: string;
    feedback: string;
}

interface PullRequestFinishSummaryMarkdown {
    withComments: string;
    withoutComments: string;
    /**
     * Shown when the agent review failed before completion (e.g. BYOK key
     * out of credits). Must include the `{{errorMessage}}` placeholder —
     * commentManager replaces it with the human-readable reason. Optional
     * for backward compatibility with older dictionaries; the resolver
     * falls back to en-US when missing.
     */
    withErrors?: string;
    /**
     * Short notice appended to the regular success copy when only
     * auxiliary checks failed (e.g. the Kody Rules agent threw). Signals
     * to the user *why* auto-approve was skipped despite the message
     * saying the review completed. Optional; the resolver falls back to
     * en-US when missing.
     */
    partialErrorsNotice?: string;
}

interface PullRequestSummaryMarkdown {
    title: string;
    codeReviewStarted: string;
    description: string;
    changedFiles: string;
    filesTable: string[];
    summary: string;
    totalFiles: string;
    totalAdditions: string;
    totalDeletions: string;
    totalChanges: string;
}

interface ConfigReviewMarkdown {
    title: string;
    interactingTitle: string;
    requestReview: string;
    requestReviewDesc: string;
    validateBusinessLogic: string;
    validateBusinessLogicDesc: string;
    provideFeedback: string;
    provideFeedbackDesc: string;
    configurationTitle: string;
    reviewOptionsTitle: string;
    reviewOptionsDesc: string;
    tableOptions: string;
    tableEnabled: string;
    configurationLink: string;
    enabled: string;
    disabled: string;
}

interface Legend {
    title: string;
    same: string;
    improved: string;
    worsened: string;
}

interface FlowMetrics {
    title: string;
    leadTime: {
        title: string;
        description: string;
    };
    leadTimeInWip: {
        title: string;
        description: string;
    };
    throughput: {
        title: string;
        description: string;
        items: string;
    };
    bugRatio: {
        title: string;
        description: string;
    };
    leadTimeByColumn: {
        title: string;
        description: string;
    };
}

interface DoraMetrics {
    title: string;
    deployFrequency: {
        title: string;
        description: string;
        value: string;
    };
    leadTimeForChange: {
        title: string;
        description: string;
        value: string;
    };
}

interface Percentiles {
    p50: string;
    p75: string;
    p95: string;
}

interface DiscordFormatter {
    title: string;
    legend: Legend;
    flowMetrics: FlowMetrics;
    doraMetrics: DoraMetrics;
    percentiles: Percentiles;
}

interface ReviewCadenceInfo {
    automaticTitle: string;
    automaticDesc: string;
    autoPauseTitle: string;
    autoPauseDesc: string;
    manualTitle: string;
    manualDesc: string;
}

interface Translations {
    reviewComment: ReviewComment;
    pullRequestFinishSummaryMarkdown: PullRequestFinishSummaryMarkdown;
    pullRequestSummaryMarkdown: PullRequestSummaryMarkdown;
    configReviewMarkdown: ConfigReviewMarkdown;
    discordFormatter: DiscordFormatter;
    reviewCadenceInfo: ReviewCadenceInfo;
}

enum TranslationsCategory {
    ReviewComment = 'reviewComment',
    PullRequestFinishSummaryMarkdown = 'pullRequestFinishSummaryMarkdown',
    PullRequestSummaryMarkdown = 'pullRequestSummaryMarkdown',
    ConfigReviewMarkdown = 'configReviewMarkdown',
    DiscordFormatter = 'discordFormatter',
    ReviewCadenceInfo = 'reviewCadenceInfo',
}

export {
    getTranslationsForLanguage,
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
};
