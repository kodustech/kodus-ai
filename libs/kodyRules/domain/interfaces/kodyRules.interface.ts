import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import z from 'zod';

export { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';

export interface FindMemoriesFilters {
    repositoryId?: string;
    directoryId?: string;
    path?: string;
    keywords?: string[];
    limit?: number;
}

export interface FindMemoriesResult {
    uuid?: string;
    title: string;
    rule: string;
    repositoryId: string;
    directoryId?: string;
    path?: string;
    createdAt?: string;
    link: string;
}

export enum KodyRuleProcessingStatus {
    PENDING = 'pending',
    PROCESSING = 'processing',
    COMPLETED = 'completed',
    FAILED = 'failed',
}

export interface IKodyRuleReferenceSyncError {
    readonly fileName: string;
    readonly message: string;
    readonly errorType:
        | 'not_found'
        | 'invalid_path'
        | 'fetch_error'
        | 'file_too_large'
        | 'parsing_error';
    readonly attemptedPaths?: string[];
    readonly timestamp: Date;
}

export interface IKodyRules {
    uuid?: string;
    organizationId: string;
    rules: Partial<IKodyRule>[];
    createdAt?: Date;
    updatedAt?: Date;
}

export interface IKodyRule {
    uuid?: string;
    title: string;
    rule: string;
    path?: string;
    sourcePath?: string;
    centralizedConfig?: IKodyRuleCentralizedConfig;
    sourceAnchor?: string;
    status: KodyRulesStatus;
    severity: string;
    label?: string;
    type?: KodyRulesType;
    extendedContext?: IKodyRulesExtendedContext;
    examples?: IKodyRulesExample[];
    repositoryId: string;
    origin?: KodyRulesOrigin;
    createdAt?: Date;
    updatedAt?: Date;
    reason?: string | null;
    scope?: KodyRulesScope;
    directoryId?: string;
    inheritance?: IKodyRulesInheritance;
    contextReferenceId?: string;
    requestType?: KodyRuleRequestType;
    targetRuleUuid?: string;
    resolvedAt?: Date;
    resolvedBy?: string;
    /**
     * Set by the IDE-rule sync flow when the source file currently
     * carries an `@kody-sync` marker — the per-file override that
     * keeps a rule synchronized even with the repository's
     * `ideRulesSyncEnabled=false`. Recomputed from file content on
     * every sync, so flipping the toggle or editing the marker
     * self-corrects on the next sync of that file.
     *
     * Consumed by the web UI to exclude such rules from the
     * "orphan auto-sync" chip (they're not orphans, the backend
     * keeps maintaining them) and to render a pin affordance on
     * the Auto-sync origin badge.
     */
    pinnedSync?: boolean;
}

export interface IKodyRuleCentralizedConfig {
    path: string;
    status: KodyRuleCentralizedStatus;
}

export interface IKodyRuleMemory extends Omit<
    IKodyRule,
    | 'type'
    | 'severity'
    | 'scope'
    | 'examples'
    | 'inheritance'
    | 'contextReferenceId'
    | 'extendedContext'
    | 'sourceAnchor'
> {
    type: KodyRulesType.MEMORY;
}

export interface IKodyRulesExtendedContext {
    todo: string;
}

export interface IKodyRulesExample {
    snippet: string;
    isCorrect: boolean;
}

export interface IKodyRulesInheritance {
    inheritable: boolean;
    exclude: string[];
    include: string[];
}

export interface IKodyRuleExternalReference {
    readonly filePath: string;
    readonly originalText?: string; // Texto original da referência (ex: "@file:README.md")
    readonly lineRange?: {
        start: number;
        end: number;
    };
    readonly description?: string;
    readonly repositoryName?: string;
    readonly lastContentHash?: string; // Hash do conteúdo do arquivo
    readonly lastValidatedAt?: Date;
    readonly estimatedTokens?: number;
    readonly lastFetchError?: {
        readonly message: string;
        readonly errorType: string;
        readonly timestamp: Date;
    };
}

export enum KodyRulesOrigin {
    USER = 'user',
    LIBRARY = 'library',
    GENERATED = 'generated',
}

export enum KodyRulesStatus {
    ACTIVE = 'active',
    REJECTED = 'rejected',
    PENDING = 'pending',
    APPLIED = 'applied',
    DELETED = 'deleted',
    /**
     * Soft-disable: rule remains in the user's list (and in audit history)
     * but is not enforced by the code review pipeline. Used by the IDE
     * auto-sync toggle-off "Pause enforcement" action so users can disable
     * imported rules without losing them, and resume them later.
     *
     * Filters that gate enforcement (e.g. `KodyRulesValidationService.filterKodyRules`)
     * MUST treat `PAUSED` the same as non-`ACTIVE` and skip the rule.
     * Filters that gate visibility (e.g. listing the user's rules) MUST
     * keep `PAUSED` rules so the UI can surface them and let the user
     * resume.
     */
    PAUSED = 'paused',
}

export enum KodyRuleCentralizedStatus {
    SYNCED = 'synced',
    PENDING_ADD = 'pending_add',
    PENDING_EDIT = 'pending_edit',
    PENDING_DELETE = 'pending_delete',
}

export enum KodyRulesScope {
    PULL_REQUEST = 'pull-request',
    FILE = 'file',
}

export enum KodyRulesType {
    STANDARD = 'standard',
    MEMORY = 'memory',
}

export enum KodyRuleRequestType {
    MEMORY_CREATE = 'memory_create',
    MEMORY_UPDATE = 'memory_update',
}

/**
 * Resolves the effective SeverityLevel for a Kody Rule.
 * Reads `severity` (the only source of truth); defaults to HIGH when missing
 * or set to an unrecognized value.
 */
export function resolveKodyRuleSeverityLevel(
    rule: Partial<IKodyRule>,
): SeverityLevel {
    switch ((rule.severity || '').toLowerCase()) {
        case SeverityLevel.CRITICAL:
            return SeverityLevel.CRITICAL;
        case SeverityLevel.HIGH:
            return SeverityLevel.HIGH;
        case SeverityLevel.MEDIUM:
            return SeverityLevel.MEDIUM;
        case SeverityLevel.LOW:
            return SeverityLevel.LOW;
        default:
            return SeverityLevel.HIGH;
    }
}

export const kodyRulesTypeSchema = z.enum([...Object.values(KodyRulesType)] as [
    KodyRulesType,
    ...KodyRulesType[],
]);

export const kodyRulesExtendedContextSchema = z.object({
    todo: z.string(),
});

export const kodyRulesExampleSchema = z.object({
    snippet: z.string(),
    isCorrect: z.boolean(),
});

export const kodyRulesInheritanceSchema = z.object({
    inheritable: z.boolean(),
    exclude: z.array(z.string()),
    include: z.array(z.string()),
});

export const kodyRuleExternalReferenceSchema = z.object({
    filePath: z.string(),
    originalText: z.string().optional(),
    lineRange: z
        .object({
            start: z.number(),
            end: z.number(),
        })
        .optional(),
    description: z.string().optional(),
    repositoryName: z.string().optional(),
    lastContentHash: z.string().optional(),
    lastValidatedAt: z.date().optional(),
    estimatedTokens: z.number().optional(),
    lastFetchError: z
        .object({
            message: z.string(),
            errorType: z.string(),
            timestamp: z.date(),
        })
        .optional(),
});

export const kodyRuleReferenceSyncErrorSchema = z.object({
    fileName: z.string(),
    message: z.string(),
    errorType: z.enum([
        'not_found',
        'invalid_path',
        'fetch_error',
        'file_too_large',
        'parsing_error',
    ]),
    attemptedPaths: z.array(z.string()).optional(),
    timestamp: z.date(),
});

const kodyRulesOriginSchema = z.enum([...Object.values(KodyRulesOrigin)] as [
    KodyRulesOrigin,
    ...KodyRulesOrigin[],
]);

const kodyRulesStatusSchema = z.enum([...Object.values(KodyRulesStatus)] as [
    KodyRulesStatus,
    ...KodyRulesStatus[],
]);

const kodyRuleCentralizedStatusSchema = z.enum([
    ...Object.values(KodyRuleCentralizedStatus),
] as [KodyRuleCentralizedStatus, ...KodyRuleCentralizedStatus[]]);

const kodyRulesScopeSchema = z.enum([...Object.values(KodyRulesScope)] as [
    KodyRulesScope,
    ...KodyRulesScope[],
]);

const kodyRuleRequestTypeSchema = z.enum([
    ...Object.values(KodyRuleRequestType),
] as [KodyRuleRequestType, ...KodyRuleRequestType[]]);

export const kodyRuleSchema = z.object({
    uuid: z.string().optional(),
    title: z.string(),
    rule: z.string(),
    path: z.string().optional(),
    sourcePath: z.string().optional(),
    centralizedConfig: z
        .object({
            path: z.string(),
            status: kodyRuleCentralizedStatusSchema,
        })
        .optional(),
    sourceAnchor: z.string().optional(),
    status: kodyRulesStatusSchema,
    severity: z.string(),
    label: z.string().optional(),
    type: kodyRulesTypeSchema.optional(),
    extendedContext: kodyRulesExtendedContextSchema.optional(),
    examples: z.array(kodyRulesExampleSchema).optional(),
    repositoryId: z.string(),
    origin: kodyRulesOriginSchema.optional(),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional(),
    reason: z.string().nullable().optional(),
    scope: kodyRulesScopeSchema.optional(),
    inheritance: kodyRulesInheritanceSchema.optional(),
    directoryId: z.string().optional(),
    contextReferenceId: z.string().optional(),
    requestType: kodyRuleRequestTypeSchema.optional(),
    targetRuleUuid: z.string().optional(),
    resolvedAt: z.date().optional(),
    resolvedBy: z.string().optional(),
    pinnedSync: z.boolean().optional(),
});
