import { ProgrammingLanguage } from '@/shared/domain/enums/programming-language.enum';

export type KodyRulesExamples = {
    snippet: string;
    isCorrect: boolean;
}

export type LibraryKodyRule = {
    uuid: string;
    title: string;
    rule: string;
    why_is_this_important: string;
    severity: string;
    examples?: KodyRulesExamples[];
    tags?: string[];
}

export type KodyRuleFilters = {
    title?: string;
    severity?: string;
    tags?: string[];
    language?: ProgrammingLanguage;
};
