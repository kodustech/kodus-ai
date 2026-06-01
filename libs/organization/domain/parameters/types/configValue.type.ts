import { LanguageValue } from '@libs/core/domain/enums/language-parameter.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';

type DayOfWeek = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

type BooleanMap<T extends string> = {
    [key in T]: boolean;
};

type CheckinFrequency = BooleanMap<DayOfWeek>;

type SessionFrequency = 'daily' | 'weekly';

export type SectionType =
    | 'releaseNotes'
    | 'pullRequestsOpened'
    | 'lateWorkItems'
    | 'teamArtifacts'
    | 'teamDoraMetrics'
    | 'teamFlowMetrics';

type Section = {
    id: SectionType;
    active: boolean;
    order: number;
    additionalConfig?: {
        frequency?: SessionFrequency;
    };
};

type SectionConfig = {
    [key in SectionType]?: Section;
};

export type CheckinConfigValue = {
    checkinId: string;
    checkinName: string;
    frequency: CheckinFrequency;
    sections: SectionConfig;
    checkinTime: string;
};

export type PlatformConfigValue = {
    finishOnboard: boolean;
    finishProjectManagementConnection: boolean;
    kodyLearningStatus: KodyLearningStatus;
    /**
     * Consecutive rule-generation runs that hard-crashed before completing
     * — bumped when entering `GENERATING_RULES`, reset to 0 on any
     * completion. The KodyLearning cron stops retrying once this reaches
     * `MAX_STUCK_RETRIES`.
     */
    kodyLearningStuckRetries?: number;
};

export enum KodyLearningStatus {
    ENABLED = 'enabled',
    DISABLED = 'disabled',
    GENERATING_RULES = 'generating_rules',
    GENERATING_CONFIG = 'generating_config',
}

export type CentralizedConfigActivePullRequest = {
    prUrl: string;
    prNumber?: number;
    sourceBranch: string;
    targetBranch?: string;
    repository: {
        id: string;
        name: string;
    };
    createdAt: string;
    updatedAt: string;
};

export type CentralizedConfigParameter = {
    enabled: boolean;
    repository: {
        name: string;
        id: string;
    } | null;
    activePullRequest?: CentralizedConfigActivePullRequest | null;
};

interface KnownConfigs {
    [ParametersKey.CODE_REVIEW_CONFIG]: CodeReviewParameter;
    [ParametersKey.LANGUAGE_CONFIG]: LanguageValue;
    [ParametersKey.PLATFORM_CONFIGS]: PlatformConfigValue;
    [ParametersKey.CENTRALIZED_CONFIG]: CentralizedConfigParameter;
}

export type ConfigValueMap = {
    [K in ParametersKey]: K extends keyof KnownConfigs ? KnownConfigs[K] : any;
};
