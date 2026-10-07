/**
 * What the judge reads and returns. The task itself is graded once, by the
 * runtime, before the judge runs; the judge never reclassifies it.
 */
export type TaskQuality = 'EMPTY' | 'MINIMAL' | 'PARTIAL' | 'COMPLETE';

export type BusinessLogicValidationMode =
    'full_analysis' | 'limitation_response';
export type TaskContextStatus = 'missing' | 'weak' | 'usable';
export type PrDiffStatus = 'missing' | 'usable';
export type BusinessLogicReason =
    | 'analysis_ready'
    | 'task_context_missing'
    | 'task_context_weak'
    | 'pr_diff_missing'
    | 'analyzer_failure'
    | 'parser_fallback';

/** The analyzer's conclusion on a completed analysis. */
export type ValidationStatus = 'compliant' | 'issues_found' | 'scope_mismatch';
export type ValidationFindingSeverity = 'must_fix' | 'suggestion' | 'info';

export interface ValidationFinding {
    severity: ValidationFindingSeverity;
    title: string;
}

export interface ValidationResult {
    needsMoreInfo: boolean;
    missingInfo?: string;
    summary: string;
    mode?: BusinessLogicValidationMode;
    reason?: BusinessLogicReason;
    taskContextStatus?: TaskContextStatus;
    prDiffStatus?: PrDiffStatus;
    confidence?: 'low' | 'medium' | 'high';
    /** Verdict of a completed analysis. Callers read this, never `summary`. */
    status?: ValidationStatus;
    findings?: ValidationFinding[];
    /** One verdict per requirement of the task. */
    requirements?: RequirementVerdict[];
    /** Changes the task doesn't ask for. */
    outOfScope?: OutOfScopeChange[];
    /** The whole diff works on a different domain than the task. */
    scopeMismatch?: boolean;
}

/**
 * Where a requirement stands in the PR. `check_manually` is for what code
 * can't show (visual, flow) or what the judge couldn't see; it never fails
 * the check.
 */
export type RequirementState = 'met' | 'partial' | 'missing' | 'check_manually';
export type Confidence = 'low' | 'medium' | 'high';

export interface CodeLocation {
    file: string;
    line?: number;
}

/** Someone other than the author waived a requirement or a change (UC-37). */
export interface Acceptance {
    by: string;
    reason?: string;
    /** Where the work went, e.g. another task id. */
    movedTo?: string;
    at: string;
}

export interface RequirementVerdict {
    /** The requirement, quoted from the task when it can be. */
    requirement: string;
    /** Where in the task it came from, e.g. "AC #2". */
    source?: string;
    state: RequirementState;
    evidence: CodeLocation[];
    /** What the code does or lacks, in the team's language. */
    note?: string;
    /** What to do, in the team's language. */
    action?: string;
    confidence: Confidence;
    /** Visual and flow requirements can't be confirmed from code. */
    kind?: 'behavior' | 'visual' | 'flow';
    /** What area it's about, so a lead sees what is most often missed (UC-42). */
    topic?: RequirementTopic;
    /** Set by the runtime when it moved the judge's state to `check_manually`. */
    downgraded?: 'low_confidence' | 'not_in_diff' | 'visual';
    /** The state the judge gave before a downgrade. */
    judgedState?: RequirementState;
    /** A previous state this re-check replaced, e.g. "was missing". */
    previousState?: RequirementState;
    accepted?: Acceptance;
    /** The author disputed it; whether Kody changed the state (UC-38). */
    disputed?: 'overturned' | 'upheld';
}

export const REQUIREMENT_TOPICS = [
    'empty_and_error_states',
    'permissions',
    'default_values',
    'validation',
    'audit_and_logging',
    'data_and_persistence',
    'notifications',
    'ui_and_copy',
    'integrations',
    'performance',
    'other',
] as const;
export type RequirementTopic = (typeof REQUIREMENT_TOPICS)[number];

/** A change in the PR the task doesn't ask for (NOT IN TASK). */
export interface OutOfScopeChange {
    change: string;
    evidence: CodeLocation[];
    action?: string;
    accepted?: Acceptance;
}
