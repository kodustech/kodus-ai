import { ProgrammingLanguage } from '@/shared/domain/enums/programming-language.enum';

export type KodyRulesExamples = {
    snippet: string;
    isCorrect: boolean;
};

export type LibraryKodyRule = {
    uuid: string;
    title: string;
    rule: string;
    why_is_this_important: string;
    severity: string;
    /**
     * Optional list of MCP providers (display hint for UI).
     * Examples: ["Sentry", "Datadog"], ["Linear", "Jira"].
     */
    required_mcps?: string[];
    examples?: KodyRulesExamples[];
    tags?: string[];
    buckets?: string[];
    language?: string;
    scope?: string;
    bad_example?: string;
    good_example?: string;
    // Feedback fields - optional (só aparece se usuário estiver logado)
    positiveCount?: number;
    negativeCount?: number;
    userFeedback?: 'positive' | 'negative' | null;
    plug_and_play?: boolean;
};

export type BucketInfo = {
    slug: string;
    title: string;
    description: string;
    rulesCount: number;
};

export type KodyRuleFilters = {
    title?: string;
    severity?: string;
    tags?: string[];
    language?: ProgrammingLanguage;
    buckets?: string[];
    plug_and_play?: boolean;
    needMCPS?: boolean;
};
