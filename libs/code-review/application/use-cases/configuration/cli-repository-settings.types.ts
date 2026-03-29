export type CliRepositorySettingsSeverity =
    | 'low'
    | 'medium'
    | 'high'
    | 'critical';

export type CliRepositorySettingsLevel =
    | 'default'
    | 'global'
    | 'repository'
    | 'repository_file'
    | 'directory'
    | 'directory_file';

export type CliRepositorySettingsSource = {
    level: CliRepositorySettingsLevel;
    overriddenLevel?: CliRepositorySettingsLevel;
};

export type CliRepositorySettingsSources = {
    reviewEnabled: CliRepositorySettingsSource;
    autoApproveEnabled: CliRepositorySettingsSource;
    requestChangesMinSeverity: CliRepositorySettingsSource;
    ignoredFilePatterns: CliRepositorySettingsSource;
    baseBranchPatterns: CliRepositorySettingsSource;
    ignoredTitlePatterns: CliRepositorySettingsSource;
};

export type CliRepositorySettings = {
    reviewEnabled: boolean;
    autoApproveEnabled: boolean;
    requestChangesMinSeverity: CliRepositorySettingsSeverity;
    ignoredFilePatterns: string[];
    baseBranchPatterns: string[];
    ignoredTitlePatterns: string[];
    sources?: CliRepositorySettingsSources;
};
