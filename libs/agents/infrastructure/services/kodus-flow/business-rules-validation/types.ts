import { Thread } from '@kodus/flow';

import type { TaskContextNormalized } from '@libs/agents/skills/capabilities';
import { CapabilityExecutionTrace } from '@libs/agents/skills/runtime/skill-runtime.types';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BlueprintContext } from '@libs/shared/blueprint/blueprint.types';

export type TaskQuality = 'EMPTY' | 'MINIMAL' | 'PARTIAL' | 'COMPLETE';
export type BusinessLogicValidationMode =
    | 'full_analysis'
    | 'limitation_response';
export type TaskContextStatus = 'missing' | 'weak' | 'usable';
export type PrDiffStatus = 'missing' | 'usable';
export type BusinessLogicReason =
    | 'analysis_ready'
    | 'task_context_missing'
    | 'task_context_weak'
    | 'pr_diff_missing'
    | 'analyzer_failure'
    | 'parser_fallback';

export interface BusinessLogicEligibility {
    mode: BusinessLogicValidationMode;
    taskContextStatus: TaskContextStatus;
    prDiffStatus: PrDiffStatus;
    reason: BusinessLogicReason;
}

export interface BusinessRulesSignals {
    ticketKeys?: string[];
    taskLinks?: string[];
    requirementKeywords?: string[];
}

export interface BusinessRulesPrepareContext extends Record<string, unknown> {
    userQuestion?: string;
    taskId?: string;
    taskUrl?: string;
    taskReference?: string;
    prDiff?: string;
    pullRequestDescription?: string;
    pullRequestNumber?: number;
    headRef?: string;
    baseRef?: string;
    repository?: {
        id?: string | number;
        name?: string;
        owner?: string;
        defaultBranch?: string;
    };
    pullRequest?: {
        pullRequestNumber?: number;
        headRef?: string;
        baseRef?: string;
    };
    taskContext?: string;
    customInstructions?: string;
    businessSignals?: BusinessRulesSignals;

    enableAgenticFallback?: boolean;
    taskContextResolutionMode?: 'cache_first' | 'agent_first';
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
}
export type { TaskContextNormalized };

/**
 * Typed context for the Business Rules Validation skill.
 * Extends BlueprintContext with step-specific fields.
 * Each field is optional — it gets populated by the corresponding step.
 */
export interface BusinessRulesContext extends BlueprintContext {
    organizationAndTeamData: OrganizationAndTeamData;
    thread?: Thread;
    prepareContext?: BusinessRulesPrepareContext;
    /** Raw PR diff text fetched by fetchPRContext step */
    prDiff?: string;
    /** PR body/description fetched by fetchPRContext step */
    prBody?: string;
    /** External task context (Jira, Notion, etc.) fetched by fetchTaskContext step */
    taskContext?: string;
    /** Normalized task payload fetched from provider-specific MCP tools */
    taskContextNormalized?: TaskContextNormalized;
    /** Quality classification set by fetchTaskContext step */
    taskQuality?: TaskQuality;
    /** Eligibility snapshot used to decide whether analyzer can run */
    analysisEligibility?: BusinessLogicEligibility;
    /** Structured result parsed from the LLM analyzer output */
    validationResult?: ValidationResult;
    /** Final markdown string returned by execute() */
    formattedResponse?: string;
    /** Trace of tools used per capability for strategy learning */
    capabilityExecutionTrace?: CapabilityExecutionTrace[];
}
