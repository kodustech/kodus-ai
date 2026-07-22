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
    /**
     * T0 compiled detector (issue #1449). When present, this rule is mechanical
     * and is checked at review time by running this pattern over added lines —
     * no LLM. Compiled once at authoring by the detector compiler and validated
     * by its gate; absent when the rule is semantic (judged by the LLM). Stored
     * inline on the embedded rule (the Mongo `rules` array is Mixed, so no
     * schema migration is needed).
     */
    detector?: IKodyRuleDetector;
    /**
     * Structured validation summary for LONG rules (> 1000 chars), generated
     * once by an LLM ("WHAT TO VALIDATE / HOW TO VALIDATE" bullets) and reused
     * on every review — measured to nearly double occurrence-recall on terse
     * models without regressing strong ones (docs/plans/
     * kody-rules-summary-productization.md).
     *
     * Consumed EXCLUSIVELY by the code-review path (the shard prompt swaps
     * `rule` for `summary.content` when `sourceHash` matches the current rule
     * text). UI, sync and export always use the full `rule`. A stale summary
     * (hash mismatch after an edit some write path missed) is ignored and
     * logged, never used. Stored inline on the embedded rule (the Mongo
     * `rules` array is a plain Array, so no schema migration is needed).
     */
    summary?: IKodyRuleSummary;
    /**
     * Atomic decomposition (see IKodyRuleAtoms). Review-path only, like
     * `summary`; stored inline on the embedded rule (plain Array in Mongo,
     * no migration).
     */
    atoms?: IKodyRuleAtoms;
    repositoryId: string;
    /**
     * For rules synced into the global scope (`repositoryId="global"`,
     * `origin=GLOBAL_REPO_FILE_SYNC`), the id of the source repository the file
     * was imported from. Undefined for every other kind of rule. Required to
     * (a) route incremental updates from that repo's merged PRs, (b) soft-delete
     * only this repo's global rules when it's removed as a source (never touching
     * user-authored global rules), and (c) key the upsert as
     * (`"global"`, `sourceRepositoryId`, `sourcePath`) so two source repos with
     * the same file path (e.g. `CLAUDE.md`) don't collide.
     */
    sourceRepositoryId?: string;
    /**
     * Git blob SHA of the source file at the last successful sync. Enables the
     * cheap short-circuit on manual resync: skip re-converting files whose SHA
     * is unchanged. Populated by the global sync flow.
     */
    lastContentHash?: string;
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
    /**
     * Set when this rule was auto-paused at creation/reactivation time
     * because activating it would have exceeded the free plan's active-rule
     * quota (`KodyRulesService.ensureFreePlanLimit`). Distinguishes a
     * plan-limit lock from a rule the user paused themselves — the web UI
     * renders these as "Locked" with an upgrade CTA instead of a plain
     * pause toggle. Cleared whenever the rule transitions to `ACTIVE`
     * (`KodyRulesService.createOrUpdate` clears it once the org is back
     * under quota or the plan changes).
     */
    lockedByPlan?: boolean;
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

export interface IKodyRuleSummary {
    /** "WHAT TO VALIDATE / HOW TO VALIDATE" bullets, English, plain text. */
    content: string;
    /** sha256 of the exact `rule` text the summary was generated from. */
    sourceHash: string;
    generatedAt: Date;
    /** Model id that generated it (BYOK main or managed default). */
    model: string;
}

/**
 * One atomic requirement decomposed from a LONG compound rule. Atoms are the
 * review-time unit of judgment: each is fed to the shard judge as its own
 * numbered item (or, when `detector` compiled, checked by the T0 regex sweep
 * with zero LLM). Suggestions always map back to the PARENT rule's uuid — the
 * customer only ever sees their own rule cited.
 */
export interface IKodyRuleAtom {
    /** Stable id: `${parentUuid}-atom-${n}`. */
    id: string;
    /** Short imperative label for the single condition. */
    title: string;
    /** One-condition "WHAT / HOW" validation spec, English. */
    spec: string;
    /** Atom-specific bad/good snippets — also the compile gate's material. */
    examples?: IKodyRulesExample[];
    /** Present when the atom compiled into a T0 regex (deterministic path). */
    detector?: IKodyRuleDetector;
    /** Audit: why the compiler kept this atom on the LLM path. */
    declineReason?: string;
}

/**
 * Atomic decomposition of a long rule (> threshold), generated once and
 * reused on every review. Replaces `summary` as the primary review-time
 * artifact when present and fresh; `summary` remains the fallback.
 * Validated on the Rails convention analog eval (2 reps/model, deliverable
 * recall): glm 76%→92%, gpt-5.4-mini 79%→84%, kimi flat — and the compound
 * -rule blind spots (requirements buried among ~18 siblings) broke.
 */
export interface IKodyRuleAtoms {
    items: IKodyRuleAtom[];
    /**
     * sha256 over `rule` text AND serialized `examples`: examples gate the
     * atom detectors, so an example edit must invalidate the decomposition
     * (unlike `summary.sourceHash`, which covers the rule text only).
     */
    sourceHash: string;
    generatedAt: Date;
    model: string;
}

/**
 * A compiled, deterministic detector for a mechanical rule (T0, issue #1449).
 * Currently a single regex applied to added-line CONTENT; the multi-clause DSL
 * (any/all/unless/ast) is a later extension of this shape.
 */
export interface IKodyRuleDetector {
    type: 'regex';
    /** JS-compatible regex source (no slashes). */
    pattern: string;
    flags?: string;
    /** model that compiled it (audit / recompile). */
    compiledBy?: string;
    /** short rationale from the compiler. */
    reason?: string;
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

/** Where a Kody Rule or Memory came from. */
export enum KodyRulesOrigin {
    MANUAL = 'manual',
    LIBRARY = 'library',
    PAST_REVIEWS = 'past_reviews',
    REPO_FILE_SYNC = 'repo_file_sync',
    /**
     * Global Kody Rule imported by syncing rule files from a repository the user
     * selected as a global-rules source (distinct from the per-repo
     * `REPO_FILE_SYNC`). Stored under `repositoryId="global"` alongside
     * user-authored global rules and the onboarding fast-sync scratch, so this
     * origin (together with `sourceRepositoryId`) is what distinguishes these
     * rules for filtering, cleanup on deselect, and the UI badge.
     */
    GLOBAL_REPO_FILE_SYNC = 'global_repo_file_sync',
    ONBOARDING_REPO_ANALYSIS = 'onboarding_repo_analysis',
    MCP_AGENT = 'mcp_agent',
    CLI = 'cli',
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

// A pending request to add a new rule/memory (CREATE) or to change an existing
// one (UPDATE, carrying `targetRuleUuid`). Applies to both rules and memories.
export enum KodyRuleRequestType {
    CREATE = 'create',
    UPDATE = 'update',
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
    sourceRepositoryId: z.string().optional(),
    lastContentHash: z.string().optional(),
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
