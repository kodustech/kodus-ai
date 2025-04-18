import { CodeReviewConfig, FileChange } from "@/config/types/general/codeReview.type";

export interface LogInfo {
    message: string;
    context?: string;
    metadata?: Record<string, any>;
}

export interface ValidateConfigResult {
    status: 'SKIP' | 'CONTINUE';
    codeReviewConfig?: CodeReviewConfig;
    loginfo?: LogInfo
}

export interface GetChangedFilesResult {
    status: 'SKIP' | 'CONTINUE';
    files?: FileChange[];
    loginfo?: LogInfo
    lastExecution?: {
        commentId?: number;
        noteId?: number;
        threadId?: number;
        lastAnalyzedCommit?: string;
    };
}

export interface GetOrCreateInitialCommentResult {
    status: 'SKIP' | 'CONTINUE';
    data?: {
        commentId: number;
        noteId: number;
        threadId?: number;
    };
    loginfo?: LogInfo
}

export interface ProcessFilesForCodeReviewResult {
    status: 'SKIP' | 'CONTINUE';
    data?: {
        overallComments: { filepath: string; summary: string }[];
        lastAnalyzedCommit: string;
        lineComments: any[];
    };
    loginfo?: LogInfo;
}

export interface CreateLineCommentsResult {
    status: 'SKIP' | 'CONTINUE';
    data?: {
        lastAnalyzedCommit: string;
        lineComments: any[];
        commentResults: any[];
    };
    loginfo?: LogInfo;
}

export interface ProcessSingleFileResult {
    status: 'SKIP' | 'CONTINUE';
    data?: {
        allSuggestions: any[];
        overallComments: { filepath: string; summary: string }[];
    };
    loginfo?: LogInfo;
}

export interface ProcessFileResult {
    allSuggestions: any[];
    overallComments: { filepath: string; summary: string }[];
}

export interface PrioritizeSuggestionsResult {
    prioritizedSuggestions: any[];
    discardedSuggestionsBySeverity: any[];
}
