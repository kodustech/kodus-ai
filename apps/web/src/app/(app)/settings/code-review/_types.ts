import type { TeamAutomation } from "@services/automations/types";
import type { LanguageValue } from "@services/parameters/types";
import type { LiteralUnion } from "react-hook-form";
import type { SeverityLevel } from "src/core/types";

export type AutomationCodeReviewConfigPageProps = {
    automation: TeamAutomation;
    repositoryId: LiteralUnion<"global", string>;
    directoryId?: string;
};

export enum CodeReviewSummaryOptions {
    REPLACE = "replace",
    CONCATENATE = "concatenate",
    COMPLEMENT = "complement",
}

export enum LimitationType {
    FILE = "file",
    PR = "pr",
    SEVERITY = "severity",
}

export enum GroupingModeSuggestions {
    MINIMAL = "minimal",
    FULL = "full",
}

enum ClusteringType {
    PARENT = "parent",
    RELATED = "related",
}

type CodeReviewSummary = {
    generatePRSummary?: boolean;
    behaviourForExistingDescription?: CodeReviewSummaryOptions;
    customInstructions?: string;
    behaviourForNewCommits?: BehaviourForNewCommits;
};

type CodeReviewPathInstruction = {
    path: string;
    instructions: string;
    severityLevel: "low" | "medium" | "high" | "critical";
};

export type CodeReviewFormType = FormattedCodeReviewConfig & {
    language: LanguageValue;
};

export type CodeReviewOptions = Record<string, boolean>;

type SuggestionControlConfig = {
    groupingMode: GroupingModeSuggestions;
    limitationType: LimitationType;
    maxSuggestions: number;
    severityLevelFilter: SeverityLevel;
    applyFiltersToKodyRules: boolean;
    severityLimits?: {
        low: number;
        medium: number;
        high: number;
        critical: number;
    };
};

export enum ReviewCadenceType {
    AUTOMATIC = "automatic",
    MANUAL = "manual",
    AUTO_PAUSE = "auto_pause",
}

export type ReviewCadence = {
    type: ReviewCadenceType;
    timeWindow?: number;
    pushesToTrigger?: number;
};

export type CodeReviewGlobalConfig = {
    ignorePaths: string[];
    baseBranches: string[];
    reviewOptions: CodeReviewOptions;
    ignoredTitleKeywords: string[];
    automatedReviewActive: boolean;
    showStatusFeedback: boolean;
    reviewCadence?: ReviewCadence;
    summary: CodeReviewSummary;
    suggestionControl?: SuggestionControlConfig;
    pullRequestApprovalActive: boolean;
    kodusConfigFileOverridesWebPreferences: boolean;
    isRequestChangesActive: boolean;
    kodyRulesGeneratorEnabled?: boolean;
    kodyLearningExcludedReviewers?: string[];
    kodyKnowledgeApproval?: {
        enabled: boolean;
    };
    runOnDraft: boolean;
    codeReviewVersion?: "legacy" | "v2" | "v3-agent";
    ideRulesSyncEnabled: boolean;
    /** Only consulted on a true→false transition of `ideRulesSyncEnabled`.
     *  Picks what happens to the rules previously imported from IDE files.
     *  Default on the backend is `keep` (least destructive) when omitted. */
    ideSyncDisableAction?: "keep" | "pause" | "delete";
    v2PromptOverrides?: {
        categories?: {
            descriptions?: {
                bug?: string;
                performance?: string;
                security?: string;
            };
        };
        severity?: {
            flags?: {
                critical?: string;
                high?: string;
                medium?: string;
                low?: string;
            };
        };
        level?: {
            critical?: string;
            issue?: string;
            warning?: string;
        };
        generation?: {
            main?: string;
        };
    };
    enableCommittableSuggestions: boolean;
    /** BYOK model-slot override for code reviews, addressed by the stable v2
     *  model id. '' = inherit (directory -> repository -> the main model set in
     *  BYOK settings). Preferred over the legacy `byokModel` name. */
    byokModelId?: string;
    /** Legacy BYOK main-model override addressed by model NAME. Retained for the
     *  read compat window: reads prefer `byokModelId` and fall back to this name
     *  when the id is absent (a repo still on the old override keeps resolving
     *  until it re-saves). New writes target `byokModelId`. */
    byokModel?: string;
    /**
     * Cross-repo context (#1576): sibling repos the agent may grep/read
     * during review. Soft cap of 3 at review time. Empty = feature off.
     */
    linkedRepositories?: LinkedRepositoryConfig[];
};

export type LinkedRepositoryConfig = {
    /** Full name of the linked repo (`owner/repo`). */
    repository: string;
    /** Free-text hint for the agent (what the link is for). */
    instructions?: string;
    /** Optional ref pin. When omitted, cascade: PR head branch → default branch. */
    ref?: string;
};

export type CodeReviewBaseConfig = {
    id: string;
    name: string;
    isSelected: boolean;
    configs: CodeReviewGlobalConfig;
};

export type DirectoryFolder = {
    id: string;
    name: string;
    path: string;
};

export type CodeReviewDirectoryConfig = CodeReviewBaseConfig & {
    folders: DirectoryFolder[];
};

export type CodeReviewRepositoryConfig = CodeReviewBaseConfig & {
    directories?: CodeReviewDirectoryConfig[];
};

export type AutomationCodeReviewConfigType = CodeReviewBaseConfig & {
    repositories: CodeReviewRepositoryConfig[];
};

export enum FormattedConfigLevel {
    DEFAULT = "default", // default overrides nothing
    GLOBAL = "global", // global can override default
    REPOSITORY = "repository", // repository can override global and default
    REPOSITORY_FILE = "repository_file", // file can override global, default and repository
    DIRECTORY = "directory", // directory can override global, default, repository and repository file
    DIRECTORY_FILE = "directory_file", // directory_file overrides all
}

export interface IFormattedConfigProperty<T> {
    value: T;
    level: FormattedConfigLevel;
    overriddenValue?: T;
    overriddenLevel?: FormattedConfigLevel;
}

export type FormattedConfig<T> = {
    [P in keyof T]: NonNullable<T[P]> extends Array<any>
        ? IFormattedConfigProperty<NonNullable<T[P]>>
        : NonNullable<T[P]> extends object
          ? FormattedConfig<NonNullable<T[P]>>
          : IFormattedConfigProperty<NonNullable<T[P]>>;
};

export type FormattedCodeReviewConfig = FormattedConfig<CodeReviewGlobalConfig>;

export type FormattedCodeReviewBaseConfig = Omit<
    CodeReviewBaseConfig,
    "configs"
> & {
    configs: FormattedCodeReviewConfig;
};

export interface FormattedGlobalCodeReviewConfig extends Omit<
    AutomationCodeReviewConfigType,
    "configs" | "repositories"
> {
    configs: FormattedCodeReviewConfig & {
        showToggleCodeReviewVersion: boolean;
    }; // TODO: remove this flag when we launch v2
    repositories: FormattedRepositoryCodeReviewConfig[];
}

/**
 * Health of the kodus-config.yml overlay for one scope. The file is read live
 * from the git provider, so it can be missing from a response whose stored
 * configuration is perfectly fine — the UI has to say so rather than present
 * partial configuration as complete.
 */
export enum KodusConfigFileOverlayStatus {
    LOADED = "loaded",
    DISABLED = "disabled",
    UNAVAILABLE = "unavailable",
    SKIPPED = "skipped",
}

export type KodusConfigFileOverlay = {
    status: KodusConfigFileOverlayStatus;
    error?: string;
};

export type FormattedRepositoryCodeReviewConfig = Omit<
    CodeReviewRepositoryConfig,
    "configs" | "directories"
> & {
    configs: FormattedCodeReviewConfig;
    directories: FormattedDirectoryCodeReviewConfig[];
    kodusConfigFile?: KodusConfigFileOverlay;
};

export type FormattedDirectoryCodeReviewConfig = Omit<
    CodeReviewDirectoryConfig,
    "configs"
> & {
    configs: FormattedCodeReviewConfig;
    kodusConfigFile?: KodusConfigFileOverlay;
};

export enum BehaviourForNewCommits {
    NONE = "none",
    REPLACE = "replace",
    CONCATENATE = "concatenate",
}
