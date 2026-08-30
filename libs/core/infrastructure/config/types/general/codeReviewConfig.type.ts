import { ErrorObject } from 'ajv';
import { DeepPartial } from 'typeorm';

import {
    IFileReference,
    IPromptReferenceSyncError,
} from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';

import {
    CodeReviewConfigWithoutLLMProvider,
    KodusConfigFile,
} from './codeReview.type';

export interface GetKodusConfigFileResponse {
    kodusConfigFile: Omit<KodusConfigFile, 'version'> | null;
    validationErrors: ErrorObject<string, Record<string, any>, unknown>[];
    isDeprecated?: boolean;
}

export type ICodeRepository = {
    avatar_url?: string;
    default_branch: string;
    http_url: string;
    id: string;
    language: string;
    name: string;
    organizationName: string;
    selected: string;
    visibility: 'private' | 'public';
    directories: Array<any>;
};

export type CodeReviewParameterBaseConfig = {
    id: string;
    name: string;
    isSelected: boolean;
    configs: DeepPartial<CodeReviewConfigWithoutLLMProvider>;
};

export type CodeReviewParameter = CodeReviewParameterBaseConfig & {
    repositories?: Array<RepositoryCodeReviewConfig>;
};

export type RepositoryCodeReviewConfig = CodeReviewParameterBaseConfig & {
    directories?: Array<DirectoryCodeReviewConfig>;
};

export type DirectoryFolder = {
    id: string;
    name: string;
    path: string;
};

export type DirectoryCodeReviewConfig = CodeReviewParameterBaseConfig & {
    folders: DirectoryFolder[];
};

export enum FormattedConfigLevel {
    DEFAULT = 'default', // default overrides nothing
    GLOBAL = 'global', // global can override default
    REPOSITORY = 'repository', // repository can override global and default
    REPOSITORY_FILE = 'repository_file', // file can override global, default and repository
    DIRECTORY = 'directory', // directory can override global, default, repository and repository file
    DIRECTORY_FILE = 'directory_file', // directory_file overrides all
}

export interface IFormattedConfigProperty<T> {
    value: T;
    level: FormattedConfigLevel;
    overriddenValue?: T;
    overriddenLevel?: FormattedConfigLevel;
    externalReferences?: {
        references: IFileReference[];
        syncErrors?: IPromptReferenceSyncError[];
        processingStatus: 'pending' | 'processing' | 'completed' | 'failed';
        lastProcessedAt: Date;
    };
}

export type FormattedConfig<T> = {
    [P in keyof T]: NonNullable<T[P]> extends Array<any>
        ? IFormattedConfigProperty<NonNullable<T[P]>>
        : NonNullable<T[P]> extends object
          ? FormattedConfig<NonNullable<T[P]>>
          : IFormattedConfigProperty<NonNullable<T[P]>>;
};

export type FormattedCodeReviewConfig =
    FormattedConfig<CodeReviewConfigWithoutLLMProvider>;

export type FormattedCodeReviewBaseConfig = Omit<
    CodeReviewParameterBaseConfig,
    'configs'
> & {
    configs: FormattedCodeReviewConfig;
};

export type FormattedGlobalCodeReviewConfig = Omit<
    CodeReviewParameter,
    'configs' | 'repositories'
> & {
    configs: FormattedCodeReviewConfig & {
        showToggleCodeReviewVersion: boolean;
    }; // TODO: remove showToggleCodeReviewVersion from here once migration is done
    repositories: FormattedRepositoryCodeReviewConfig[];
};

/**
 * Health of the `kodus-config.yml` overlay for one scope. Reading the file
 * means a live call to the git provider, which can be slow or rate-limited
 * independently of the stored configuration — so the response says whether
 * the overlay actually made it in, instead of silently returning stored
 * config that differs from what a review would use.
 */
export enum KodusConfigFileOverlayStatus {
    /** The file was read from the provider and merged into the config. */
    LOADED = 'loaded',
    /**
     * The read completed but came back empty. Either the repository has no
     * file, or a provider error was swallowed by the adapter — the two are
     * indistinguishable, so this must not be presented as a successful read.
     */
    NOT_FOUND = 'not_found',
    /** Override flag is off for this scope — no file is expected. */
    DISABLED = 'disabled',
    /** Override flag is on, but the provider did not answer in time. */
    UNAVAILABLE = 'unavailable',
    /** Caller asked for stored config only; the overlay was not attempted. */
    SKIPPED = 'skipped',
}

export type KodusConfigFileOverlay = {
    status: KodusConfigFileOverlayStatus;
    error?: string;
};

export type FormattedRepositoryCodeReviewConfig = Omit<
    RepositoryCodeReviewConfig,
    'configs' | 'directories'
> & {
    configs: FormattedCodeReviewConfig;
    directories: FormattedDirectoryCodeReviewConfig[];
    kodusConfigFile: KodusConfigFileOverlay;
};

export type FormattedDirectoryCodeReviewConfig = Omit<
    DirectoryCodeReviewConfig,
    'configs'
> & {
    configs: FormattedCodeReviewConfig;
    kodusConfigFile: KodusConfigFileOverlay;
};
