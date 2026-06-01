export type RepositorySettingsSeverity =
    | 'low'
    | 'medium'
    | 'high'
    | 'critical';

export type RepositorySettingsLevel =
    | 'default'
    | 'global'
    | 'repository'
    | 'repository_file'
    | 'directory'
    | 'directory_file';

export interface RepositorySettingSource {
    level: RepositorySettingsLevel;
    overriddenLevel?: RepositorySettingsLevel;
}

export interface RepositorySettingsSources {
    reviewEnabled: RepositorySettingSource;
    autoApproveEnabled: RepositorySettingSource;
    requestChangesMinSeverity: RepositorySettingSource;
    ignoredFilePatterns: RepositorySettingSource;
    baseBranchPatterns: RepositorySettingSource;
    ignoredTitlePatterns: RepositorySettingSource;
}

export interface RepositorySettings {
    reviewEnabled: boolean;
    autoApproveEnabled: boolean;
    requestChangesMinSeverity: RepositorySettingsSeverity;
    ignoredFilePatterns: string[];
    baseBranchPatterns: string[];
    ignoredTitlePatterns: string[];
    sources?: RepositorySettingsSources;
}
