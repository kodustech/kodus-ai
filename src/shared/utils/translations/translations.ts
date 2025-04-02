import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';
import * as path from 'path';
import { loadJsonFile } from '../transforms/file';

const getTranslationsForLanguage = (
    language: LanguageValue,
): Translations | null => {
    try {
        const dictionaryPath = path.resolve(
            __dirname,
            `./dictionaries/${language}.json`,
        );
        return loadJsonFile(dictionaryPath);
    } catch (error) {
        console.error(
            `Translation file for language "${language}" not found. Falling back to en-US.`,
        );
        const dictionaryPath = path.resolve(
            __dirname,
            './dictionaries/en-US.json',
        );
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
interface Translations {
    reviewComment: ReviewComment;
    pullRequestFinishSummaryMarkdown: PullRequestFinishSummaryMarkdown;
    pullRequestSummaryMarkdown: PullRequestSummaryMarkdown;
    configReviewMarkdown: ConfigReviewMarkdown;
    discordFormatter: DiscordFormatter;
}

enum TranslationsCategory {
    ReviewComment = 'reviewComment',
    PullRequestFinishSummaryMarkdown = 'pullRequestFinishSummaryMarkdown',
    PullRequestSummaryMarkdown = 'pullRequestSummaryMarkdown',
    ConfigReviewMarkdown = 'configReviewMarkdown',
    DiscordFormatter = 'discordFormatter',
}

export {
    getTranslationsForLanguage,
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
};
