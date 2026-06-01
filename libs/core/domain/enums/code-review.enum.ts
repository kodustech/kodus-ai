export enum BehaviourForExistingDescription {
    REPLACE = 'replace',
    CONCATENATE = 'concatenate',
    COMPLEMENT = 'complement',
}

export enum LimitationType {
    FILE = 'file',
    PR = 'pr',
    SEVERITY = 'severity',
}

export enum GroupingModeSuggestions {
    MINIMAL = 'minimal',
    SMART = 'smart',
    FULL = 'full',
}

export enum ClusteringType {
    PARENT = 'parent',
    RELATED = 'related',
}

export enum CodeReviewVersion {
    LEGACY = 'legacy',
    v2 = 'v2',
    V3_AGENT = 'v3-agent',
}

export enum ReviewModeResponse {
    LIGHT_MODE = 'light_mode',
    HEAVY_MODE = 'heavy_mode',
}

export enum ReviewModeConfig {
    LIGHT_MODE_FULL = 'light_mode_full',
    LIGHT_MODE_PARTIAL = 'light_mode_partial',
    HEAVY_MODE = 'heavy_mode',
}

export enum ReviewPreset {
    SPEED = 'speed',
    SAFETY = 'safety',
    COACH = 'coach',
}

export enum SuggestionType {
    CROSS_FILE = 'cross_file',
}

export enum ReviewCadenceType {
    AUTOMATIC = 'automatic',
    MANUAL = 'manual',
    AUTO_PAUSE = 'auto_pause',
}

export enum ReviewCadenceState {
    AUTOMATIC = 'automatic',
    COMMAND = 'command',
    PAUSED = 'paused',
}

export enum BehaviourForNewCommits {
    NONE = 'none',
    REPLACE = 'replace',
    CONCATENATE = 'concatenate',
}
