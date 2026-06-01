import type { RepositorySettings } from '../types/repo-config.js';
import { CommandError } from './command-errors.js';

export const SUPPORTED_REPO_SETTING_KEYS = [
    'review.enabled',
    'review.autoApprove',
    'review.requestChanges.minSeverity',
    'patterns.ignoreFiles',
    'patterns.baseBranches',
    'patterns.ignoreTitles',
] as const;

export function parseRepositoryPatternList(value: string): string[] {
    return value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function parseBooleanSetting(key: string, value: string): boolean {
    if (value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }

    throw new CommandError(
        'INVALID_INPUT',
        `Setting '${key}' expects 'true' or 'false'.`,
    );
}

export function validateRepositorySettingKey(key: string): void {
    if (!SUPPORTED_REPO_SETTING_KEYS.includes(key as never)) {
        throw new CommandError(
            'INVALID_INPUT',
            `Unsupported setting key '${key}'. Supported keys: ${SUPPORTED_REPO_SETTING_KEYS.join(', ')}`,
        );
    }
}

export function applyRepositorySetting(
    settings: RepositorySettings,
    key: string,
    value: string,
): RepositorySettings {
    validateRepositorySettingKey(key);

    switch (key) {
        case 'review.enabled':
            return {
                ...settings,
                reviewEnabled: parseBooleanSetting(key, value),
            };
        case 'review.autoApprove':
            return {
                ...settings,
                autoApproveEnabled: parseBooleanSetting(key, value),
            };
        case 'review.requestChanges.minSeverity':
            if (!['low', 'medium', 'high', 'critical'].includes(value)) {
                throw new CommandError(
                    'INVALID_INPUT',
                    `Setting '${key}' expects one of: low, medium, high, critical.`,
                );
            }
            return {
                ...settings,
                requestChangesMinSeverity:
                    value as RepositorySettings['requestChangesMinSeverity'],
            };
        case 'patterns.ignoreFiles':
            return {
                ...settings,
                ignoredFilePatterns: parseRepositoryPatternList(value),
            };
        case 'patterns.baseBranches':
            return {
                ...settings,
                baseBranchPatterns: parseRepositoryPatternList(value),
            };
        case 'patterns.ignoreTitles':
            return {
                ...settings,
                ignoredTitlePatterns: parseRepositoryPatternList(value),
            };
        default:
            throw new CommandError(
                'INVALID_INPUT',
                `Unsupported setting key '${key}'.`,
            );
    }
}
