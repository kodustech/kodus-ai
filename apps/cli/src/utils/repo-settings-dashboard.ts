import { CommandError } from './command-errors.js';

export const SUPPORTED_REPO_SETTINGS_SECTIONS = [
    'general',
    'review-categories',
    'custom-prompts',
    'suggestion-control',
    'pr-summary',
    'kody-rules',
    'custom-messages',
    'business-rules',
] as const;

export type RepositorySettingsSection =
    (typeof SUPPORTED_REPO_SETTINGS_SECTIONS)[number];

const SECTION_LABELS: Record<RepositorySettingsSection, string> = {
    'general': 'General',
    'review-categories': 'Review Categories',
    'custom-prompts': 'Custom Prompts',
    'suggestion-control': 'Suggestion Control',
    'pr-summary': 'PR Summary',
    'kody-rules': 'Kody Rules',
    'custom-messages': 'Custom Messages',
    'business-rules': 'Business Rules',
};

export function getKodusAppUrl(): string {
    const configuredUrl = process.env.KODUS_APP_URL?.trim();
    return configuredUrl || 'https://app.kodus.io';
}

export function validateRepositorySettingsSection(
    section: string | undefined,
): RepositorySettingsSection {
    const normalized = section?.trim().toLowerCase() || 'general';
    if (
        !SUPPORTED_REPO_SETTINGS_SECTIONS.includes(
            normalized as RepositorySettingsSection,
        )
    ) {
        throw new CommandError(
            'INVALID_INPUT',
            `Unsupported section '${section}'. Supported sections: ${SUPPORTED_REPO_SETTINGS_SECTIONS.join(', ')}`,
        );
    }

    return normalized as RepositorySettingsSection;
}

export function getRepositorySettingsSectionLabel(
    section: RepositorySettingsSection,
): string {
    return SECTION_LABELS[section];
}
