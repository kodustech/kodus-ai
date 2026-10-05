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
}
