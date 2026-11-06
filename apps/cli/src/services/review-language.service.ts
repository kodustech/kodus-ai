import { reviewMessagesApi } from './api/review-messages.api.js';
import { userContextService } from './user-context.service.js';
import { ApiError } from '../types/errors.js';
import { CommandError } from '../utils/command-errors.js';

const FEATURE = 'Review language';

/** LanguageValue (libs/core/domain/enums/language-parameter.enum.ts), titled as the General page lists them. */
export const REVIEW_LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
    { code: 'en-US', name: 'English' },
    { code: 'pt-BR', name: 'Portuguese (Brazil)' },
    { code: 'pt-PT', name: 'Portuguese (Portugal)' },
    { code: 'es-ES', name: 'Spanish' },
    { code: 'fr-FR', name: 'French' },
    { code: 'de-DE', name: 'German' },
    { code: 'it-IT', name: 'Italian' },
    { code: 'nl-NL', name: 'Dutch' },
    { code: 'pl-PL', name: 'Polish' },
    { code: 'ru-RU', name: 'Russian' },
    { code: 'ar-SA', name: 'Arabic' },
    { code: 'zh-CN', name: 'Chinese (Mainland)' },
    { code: 'hi-IN', name: 'Hindi' },
    { code: 'ja-JP', name: 'Japanese' },
    { code: 'ko-KR', name: 'Korean' },
    { code: 'vi-VN', name: 'Vietnamese' },
    { code: 'th-TH', name: 'Thai' },
    { code: 'sv-SE', name: 'Swedish' },
    { code: 'fi-FI', name: 'Finnish' },
    { code: 'nb-NO', name: 'Norwegian' },
    { code: 'da-DK', name: 'Danish' },
    { code: 'cs-CZ', name: 'Czech' },
    { code: 'hu-HU', name: 'Hungarian' },
    { code: 'uk-UA', name: 'Ukrainian' },
    { code: 'ta-IN', name: 'Tamil' },
    { code: 'te-IN', name: 'Telugu' },
    { code: 'he-IL', name: 'Hebrew' },
    { code: 'tr-TR', name: 'Turkish' },
    { code: 'id-ID', name: 'Indonesian' },
    { code: 'ms-MY', name: 'Malay' },
    { code: 'el-GR', name: 'Greek' },
    { code: 'ro-RO', name: 'Romanian' },
    { code: 'bg-BG', name: 'Bulgarian' },
];

/** What the settings layout falls back to when the team never saved one. */
export const DEFAULT_REVIEW_LANGUAGE = 'en-US';

export type ReviewLanguageResult = {
    team: string;
    language: string;
    name: string;
    isDefault: boolean;
};

export function resolveLanguage(input: string): { code: string; name: string } {
    const wanted = input.trim().toLowerCase();
    const match = REVIEW_LANGUAGES.find(
        (language) =>
            language.code.toLowerCase() === wanted ||
            language.name.toLowerCase() === wanted,
    );
    if (!match) {
        throw new CommandError(
            'INVALID_INPUT',
            `Unknown language '${input}'. Run 'kodus config remote language list' for the codes.`,
        );
    }
    return match;
}

function nameOf(code: string): string {
    return (
        REVIEW_LANGUAGES.find((language) => language.code === code)?.name ??
        code
    );
}

class ReviewLanguageService {
    async show(options: { team?: string } = {}): Promise<ReviewLanguageResult> {
        const ctx = await userContextService.resolve(FEATURE, options);
        const parameter = await reviewMessagesApi
            .getLanguage(ctx.accessToken, ctx.teamId)
            .catch((error: unknown) => {
                if (error instanceof ApiError && error.statusCode === 404) {
                    return null;
                }
                throw error;
            });
        const stored =
            typeof parameter?.configValue === 'string'
                ? parameter.configValue
                : undefined;
        const language = stored ?? DEFAULT_REVIEW_LANGUAGE;
        return {
            team: ctx.teamName,
            language,
            name: nameOf(language),
            isDefault: stored === undefined,
        };
    }

    /** The language is a team parameter: it covers every repository and directory of the team. */
    async set(
        input: string,
        options: { team?: string } = {},
    ): Promise<ReviewLanguageResult> {
        const language = resolveLanguage(input);
        const ctx = await userContextService.resolve(FEATURE, options);
        await reviewMessagesApi.setLanguage(
            ctx.accessToken,
            ctx.teamId,
            language.code,
        );
        return {
            team: ctx.teamName,
            language: language.code,
            name: language.name,
            isDefault: false,
        };
    }
}

export const reviewLanguageService = new ReviewLanguageService();
