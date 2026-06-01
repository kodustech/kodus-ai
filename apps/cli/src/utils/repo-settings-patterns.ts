import type { RepositorySettings } from '../types/repo-config.js';
import { CommandError } from './command-errors.js';

export const SUPPORTED_REPO_PATTERN_FIELDS = [
    'ignore-files',
    'base-branches',
    'ignore-titles',
] as const;

export type RepositoryPatternField =
    (typeof SUPPORTED_REPO_PATTERN_FIELDS)[number];

export function validateRepositoryPatternField(
    field: string,
): RepositoryPatternField {
    const normalized = field.trim().toLowerCase();
    if (
        !SUPPORTED_REPO_PATTERN_FIELDS.includes(
            normalized as RepositoryPatternField,
        )
    ) {
        throw new CommandError(
            'INVALID_INPUT',
            `Unsupported pattern field '${field}'. Supported pattern fields: ${SUPPORTED_REPO_PATTERN_FIELDS.join(', ')}`,
        );
    }

    return normalized as RepositoryPatternField;
}

function getPatterns(
    settings: RepositorySettings,
    field: RepositoryPatternField,
): string[] {
    switch (field) {
        case 'ignore-files':
            return settings.ignoredFilePatterns;
        case 'base-branches':
            return settings.baseBranchPatterns;
        case 'ignore-titles':
            return settings.ignoredTitlePatterns;
    }
}

function withPatterns(
    settings: RepositorySettings,
    field: RepositoryPatternField,
    patterns: string[],
): RepositorySettings {
    switch (field) {
        case 'ignore-files':
            return {
                ...settings,
                ignoredFilePatterns: patterns,
            };
        case 'base-branches':
            return {
                ...settings,
                baseBranchPatterns: patterns,
            };
        case 'ignore-titles':
            return {
                ...settings,
                ignoredTitlePatterns: patterns,
            };
    }
}

export function addRepositoryPattern(
    settings: RepositorySettings,
    field: string,
    pattern: string,
): RepositorySettings {
    const supportedField = validateRepositoryPatternField(field);
    const normalizedPattern = pattern.trim();
    if (!normalizedPattern) {
        throw new CommandError(
            'INVALID_INPUT',
            'Pattern value cannot be empty.',
        );
    }

    const existing = getPatterns(settings, supportedField);
    if (existing.includes(normalizedPattern)) {
        return settings;
    }

    return withPatterns(settings, supportedField, [
        ...existing,
        normalizedPattern,
    ]);
}

export function removeRepositoryPattern(
    settings: RepositorySettings,
    field: string,
    pattern: string,
): RepositorySettings {
    const supportedField = validateRepositoryPatternField(field);
    const normalizedPattern = pattern.trim();
    if (!normalizedPattern) {
        throw new CommandError(
            'INVALID_INPUT',
            'Pattern value cannot be empty.',
        );
    }

    return withPatterns(
        settings,
        supportedField,
        getPatterns(settings, supportedField).filter(
            (existingPattern) => existingPattern !== normalizedPattern,
        ),
    );
}
