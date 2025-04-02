import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';
import {
    getTranslationsForLanguage,
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
} from '@/shared/utils/translations/translations';

describe('translations', () => {
    beforeAll(() => {
        // Suppress console.error to avoid tests failing unexpectedly
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should return translations for the given language', () => {
        const translations = getTranslationsForLanguage(LanguageValue.ENGLISH);
        expect(translations).toBeDefined();

        const translations2 = getTranslationsForLanguage(
            LanguageValue.PORTUGUESE_BR,
        );
        expect(translations2).toBeDefined();

        const translations3 = getTranslationsForLanguage(LanguageValue.SPANISH);
        expect(translations3).toBeDefined();

        expect(translations).not.toEqual(translations2);
        expect(translations).not.toEqual(translations3);
        expect(translations2).not.toEqual(translations3);
    });

    it('should return translations for the given language and category', () => {
        const translations = getTranslationsForLanguageByCategory(
            LanguageValue.ENGLISH,
            TranslationsCategory.ConfigReviewMarkdown,
        );
        expect(translations).toBeDefined();

        const translations2 = getTranslationsForLanguageByCategory(
            LanguageValue.PORTUGUESE_BR,
            TranslationsCategory.DiscordFormatter,
        );
        expect(translations2).toBeDefined();

        const translations3 = getTranslationsForLanguageByCategory(
            LanguageValue.SPANISH,
            TranslationsCategory.PullRequestSummaryMarkdown,
        );
        expect(translations3).toBeDefined();

        expect(translations).not.toEqual(translations2);
        expect(translations).not.toEqual(translations3);
        expect(translations2).not.toEqual(translations3);
    });

    it('should fallback to en-US if the translations for the given language are not found', () => {
        const translations = getTranslationsForLanguage(
            'invalid' as LanguageValue,
        );
        expect(translations).toBeDefined();

        const enUSTranslations = getTranslationsForLanguage(
            LanguageValue.ENGLISH,
        );

        expect(translations).toEqual(enUSTranslations);
    });

    it('should return undefined if the translations for the given language and category are not found', () => {
        const translations = getTranslationsForLanguageByCategory(
            LanguageValue.ENGLISH,
            'invalid' as TranslationsCategory,
        );
        expect(translations).toBeUndefined();
    });

    it('should throw an error if no translations are found for the given or fallback language', () => {
        jest.resetModules();

        jest.doMock('@/shared/utils/transforms/file', () => ({
            loadJsonFile: jest.fn().mockImplementation(() => {
                throw new Error('Fallback translations not found');
            }),
        }));

        const {
            getTranslationsForLanguage,
            getTranslationsForLanguageByCategory,
        } = require('@/shared/utils/translations/translations');

        expect(() =>
            getTranslationsForLanguage('invalid' as LanguageValue),
        ).toThrow('Fallback translations not found');

        expect(() =>
            getTranslationsForLanguageByCategory(
                'invalid' as LanguageValue,
                'invalid' as TranslationsCategory,
            ),
        ).toThrow('Fallback translations not found');
    });
});
