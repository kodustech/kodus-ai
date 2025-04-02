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
};

export enum KodyLearningStatus {
    ENABLED = 'enabled',
    DISABLED = 'disabled',
    GENERATING_RULES = 'generating_rules',
    GENERATING_CONFIG = 'generating_config',
}
