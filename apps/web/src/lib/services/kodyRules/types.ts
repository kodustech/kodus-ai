import { ProgrammingLanguage } from "src/core/enums/programming-language";
import { SeverityLevel } from "src/core/types";

export enum KodyRuleInheritanceOrigin {
    GLOBAL = "global",
    REPOSITORY = "repository",
    DIRECTORY = "directory",
}

export type KodyRule = {
    uuid?: string;
    status: KodyRulesStatus;
    type?: KodyRulesType;
    title: string;
    rule: string;
    path: string;
    scope: "file" | "pull-request";
    severity: "low" | "medium" | "high" | "critical";
    repositoryId?: string;
    directoryId?: string;
    sourcePath?: string;
    /**
     * True when the source file currently carries an `@kody-sync`
     * marker — the per-file override that keeps the rule synced
     * even with the repo's auto-sync toggle off. Surfaced so the
     * orphan chip can exclude these (they're not orphans) and the
     * Auto-sync badge can render a pin affordance.
     */
    pinnedSync?: boolean;
    centralizedConfig?: {
        path: string;
        status: KodyRuleCentralizedStatus;
    };
    origin: KodyRulesOrigin;
    requestType?: KodyRuleRequestType;
    targetRuleUuid?: string;
    resolvedAt?: string;
    resolvedBy?: string;
    examples: KodyRulesExample[];
    inheritance?: {
        inheritable?: boolean;
        exclude?: string[];
        include?: string[];
    };
    syncError?: string;
    externalReferences?: Array<{
        filePath: string;
        repositoryName: string;
        originalText?: string;
        lineRange?: { start: number; end: number } | null;
    }>;
    syncErrors?: Array<
        | string
        | {
              fileName?: string;
              message?: string;
              errorType?: string;
              attemptedPaths?: string[];
              timestamp?: string;
          }
    >;
    referenceProcessingStatus?:
        | "completed"
        | "processing"
        | "failed"
        | "pending";
};

export type KodyRuleWithInheritanceDetails = KodyRule & {
    inherited?: KodyRuleInheritanceOrigin; // Internal frontend use only
    excluded?: boolean; // Internal frontend use only
};

export type LibraryRule = {
    uuid: string;
    title: string;
    rule: string;
    why_is_this_important: string;
    severity?: "Low" | "Medium" | "High" | "Critical";
    bad_example?: string;
    good_example?: string;
    /**
     * Optional list of MCP providers (display hint for UI).
     * Examples: ["Sentry", "Datadog"], ["Linear", "Jira"].
     */
    required_mcps?: string[];
    examples: KodyRulesExample[];
    tags: string[];
    language: keyof typeof ProgrammingLanguage;
    buckets?: string[];
    plug_and_play?: boolean;
    needMCPS?: boolean;
    scope?: string;
    positiveCount?: number;
    negativeCount?: number;
    userFeedback?: string | null;
    likesCount?: number;
    isLiked?: boolean;
};

type KodyRulesExample = {
    snippet: string;
    isCorrect: boolean;
};

export type FindLibraryKodyRulesFilters = {
    name?: string;
    severity?: KodyRule["severity"];
    tags?: string[];
    language?: keyof typeof ProgrammingLanguage;
    buckets?: string[];
    plug_and_play?: boolean;
    needMCPS?: boolean;
    requiredMcp?: string;
    uuid?: string;
    page?: number;
    limit?: number;
};

export type PaginatedResponse<T> = {
    data: T[];
    pagination: {
        currentPage: number;
        totalPages: number;
        totalItems: number;
        itemsPerPage: number;
        hasNextPage: boolean;
        hasPreviousPage: boolean;
    };
};

export type KodyRuleBucket = {
    slug: string;
    title: string;
    description: string;
    rulesCount: number;
};

export enum KodyRulesOrigin {
    USER = "user",
    LIBRARY = "library",
    GENERATED = "generated",
}

export enum KodyRulesStatus {
    ACTIVE = "active",
    REJECTED = "rejected",
    PENDING = "pending",
    APPLIED = "applied",
    DELETED = "deleted",
    /** Soft-disable. Visible in the user's list but not enforced by review.
     *  Mirror of the backend `KodyRulesStatus.PAUSED`. Reversible. */
    PAUSED = "paused",
}

export enum KodyRuleCentralizedStatus {
    SYNCED = "synced",
    PENDING_ADD = "pending_add",
    PENDING_EDIT = "pending_edit",
    PENDING_DELETE = "pending_delete",
}

export enum KodyRulesType {
    STANDARD = "standard",
    MEMORY = "memory",
}

export enum KodyRuleRequestType {
    MEMORY_CREATE = "memory_create",
    MEMORY_UPDATE = "memory_update",
}

export type KodyRulesCentralizedPrMetadata = {
    mode: "direct" | "centralized-pr";
    prUrl?: string;
    prNumber?: number;
    reused?: boolean;
    pending?: boolean;
    message?: string;
};

export type KodyRulesMutationResponse =
    | KodyRule[]
    | KodyRulesCentralizedPrMetadata;

export type KodyRuleSuggestion = {
    id: string;
    relevantFile: string;
    language: string;
    suggestionContent: string;
    existingCode: string;
    improvedCode: string;
    oneSentenceSummary: string;
    relevantLinesStart: number;
    relevantLinesEnd: number;
    label: string;
    severity: string;
    rankScore: number;
    brokenKodyRulesIds: string[];
    priorityStatus: string;
    deliveryStatus: string;
    type: string;
    createdAt: string;
    updatedAt: string;
    prNumber: number;
    prTitle: string;
    prUrl: string;
    repositoryId: string;
    repositoryFullName: string;
};

export const resolveKodyRuleDisplaySeverity = ({
    severity,
}: {
    severity?: string;
}): SeverityLevel => {
    const normalizedSeverity = severity?.toLowerCase();

    if (
        normalizedSeverity === SeverityLevel.CRITICAL ||
        normalizedSeverity === SeverityLevel.HIGH ||
        normalizedSeverity === SeverityLevel.MEDIUM ||
        normalizedSeverity === SeverityLevel.LOW
    ) {
        return normalizedSeverity as SeverityLevel;
    }

    return SeverityLevel.LOW;
};
