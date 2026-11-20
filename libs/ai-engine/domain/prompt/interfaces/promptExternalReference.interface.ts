export enum PromptSourceType {
    CUSTOM_INSTRUCTION = 'custom_instruction',
    CATEGORY_BUG = 'category_bug',
    CATEGORY_PERFORMANCE = 'category_performance',
    CATEGORY_SECURITY = 'category_security',
    SEVERITY_CRITICAL = 'severity_critical',
    SEVERITY_HIGH = 'severity_high',
    SEVERITY_MEDIUM = 'severity_medium',
    SEVERITY_LOW = 'severity_low',
    GENERATION_MAIN = 'generation_main',
    KODY_RULE = 'kody_rule',
}

export enum PromptProcessingStatus {
    PENDING = 'pending',
    PROCESSING = 'processing',
    COMPLETED = 'completed',
    FAILED = 'failed',
}

export enum PromptReferenceErrorType {
    FILE_NOT_FOUND = 'file_not_found',
    REPO_ACCESS_DENIED = 'repo_access_denied',
    DETECTION_FAILED = 'detection_failed',
    INVALID_FORMAT = 'invalid_format',
    FILE_TOO_LARGE = 'file_too_large',
    FETCH_FAILED = 'fetch_failed',
    MCP_CONNECTION_FAILED = 'mcp_connection_failed',
    MCP_EXECUTION_FAILED = 'mcp_execution_failed',
}

export interface IFileReferenceError {
    readonly type: PromptReferenceErrorType;
    readonly message: string;
    readonly attemptedPatterns: string[];
    readonly timestamp: Date;
}

export interface IFileReference {
    readonly filePath: string;
    readonly lineRange?: {
        readonly start: number;
        readonly end: number;
    };
    readonly repositoryName?: string;
    repositoryId?: string;
    readonly description?: string;
    readonly originalText?: string;
    lastContentHash: string;
    lastValidatedAt: Date;
    estimatedTokens?: number;
    lastFetchError?: IFileReferenceError;
}

/** The sync error a detection records when the model gave no usable answer. */
export const NO_USABLE_DETECTION_ANSWER =
    'Reference detection got no usable answer from the model';

export interface IPromptReferenceSyncError {
    readonly type: PromptReferenceErrorType;
    readonly message: string;
    readonly details: {
        readonly fileName?: string;
        readonly repositoryName?: string;
        readonly attemptedPaths?: string[];
        readonly timestamp?: Date;
    };
}

export interface IPromptExternalReference {
    readonly uuid?: string;
    readonly configKey: string;
    readonly sourceType: PromptSourceType;
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly directoryId?: string;
    readonly kodyRuleId?: string;
    readonly repositoryName: string;
    promptHash: string;
    contextReferenceId?: string;
    contextRequirementsHash?: string;
    readonly references: IFileReference[];
    syncErrors?: IPromptReferenceSyncError[];
    processingStatus: PromptProcessingStatus;
    lastProcessedAt: Date;
    readonly createdAt?: Date;
    updatedAt?: Date;
}

export interface ILoadedFileReference extends IFileReference {
    readonly content: string;
}

export interface IExternalPromptContext {
    customInstructions?: {
        references: ILoadedFileReference[];
        error?: string;
    };
    categories?: {
        bug?: { references: ILoadedFileReference[]; error?: string };
        performance?: { references: ILoadedFileReference[]; error?: string };
        security?: { references: ILoadedFileReference[]; error?: string };
    };
    severity?: {
        critical?: { references: ILoadedFileReference[]; error?: string };
        high?: { references: ILoadedFileReference[]; error?: string };
        medium?: { references: ILoadedFileReference[]; error?: string };
        low?: { references: ILoadedFileReference[]; error?: string };
    };
    generation?: {
        main?: { references: ILoadedFileReference[]; error?: string };
    };
}

export interface IDetectedReference {
    readonly fileName: string;
    readonly filePattern?: string;
    readonly description?: string;
    readonly repositoryName?: string;
    readonly originalText?: string;
    readonly lineRange?: {
        readonly start: number;
        readonly end: number;
    };
}
