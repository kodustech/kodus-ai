/**
 * Blueprint Pattern — Core Types
 *
 * Provides the type definitions for deterministic skill execution.
 * Skills have a blueprint (Kodus-owned execution steps) and instructions
 * (SKILL.md body, user-editable per team).
 *
 * No NestJS or @kodus/flow dependencies — pure TypeScript.
 */
import type { ZodType } from 'zod';

// ─── Context ─────────────────────────────────────────────────────────────────

/**
 * Base context bag passed between blueprint steps.
 * Each step reads from and returns a new context object (no mutation of prior state).
 * Skill-specific contexts extend this interface.
 */
export interface BlueprintContext {
    /** Team/org identifiers used for BYOK resolution and parameter lookup */
    organizationAndTeamData: unknown;
    /** Locale for LLM response formatting (e.g. 'en-US', 'pt-BR') */
    userLanguage: string;
    /** Optional conversation thread when invoked from chat context */
    thread?: unknown;
    /** Arbitrary pre-fetched data from the caller (pipeline prepareContext, etc.) */
    prepareContext?: Record<string, unknown>;
    /** Final result written by the format step */
    result?: unknown;
    /** Non-fatal error message captured during step execution */
    error?: string;
    [key: string]: unknown;
}

// ─── Step types ───────────────────────────────────────────────────────────────

/**
 * Deterministic step: runs a plain TypeScript function.
 * No LLM calls, no side effects beyond writing to context.
 */
export interface DeterministicStep<T extends BlueprintContext> {
    type: 'deterministic';
    name: string;
    contract?: BlueprintStepContract;
    /** Receives current context, returns updated context */
    fn: (ctx: T) => Promise<T>;
}

/**
 * Gate step: evaluates a condition and short-circuits if it fails.
 * When condition returns false, onFail is called and runBlueprint returns immediately.
 * Zero LLM calls are made for any subsequent steps.
 */
export interface GateStep<T extends BlueprintContext> {
    type: 'gate';
    name: string;
    contract?: BlueprintStepContract;
    /** Returns true to continue, false to short-circuit */
    condition: (ctx: T) => boolean;
    /**
     * Called when condition returns false.
     * Must return a context with a populated result/formattedResponse for the caller.
     * runBlueprint will return immediately after this with skippedAt set.
     */
    onFail: (ctx: T) => T;
}

/**
 * LLM step: delegates to the caller's runLLMStep handler.
 * The handler is responsible for loading SKILL.md instructions and calling @kodus/flow.
 */
export interface LLMStep {
    type: 'llm';
    name: string;
    contract?: BlueprintStepContract;
    /** Skill name — resolved to SKILL.md body by the caller's runLLMStep */
    skill: string;
    /** @kodus/flow agent identifier used in createAgent() / callAgent() */
    agentName: string;
}

/**
 * Format step: transforms the context after an LLM step.
 * Typically used to parse LLM output into a typed result.
 */
export interface FormatStep<T extends BlueprintContext> {
    type: 'format';
    name: string;
    contract?: BlueprintStepContract;
    fn: (ctx: T) => T;
}

/**
 * Parallel step: invokes multiple skills concurrently via ISkillRunner.runParallel().
 * Not handled by runBlueprint directly — the caller must implement parallel dispatch.
 */
export interface ParallelStep {
    type: 'parallel';
    name: string;
    contract?: BlueprintStepContract;
    /** Skill names to execute concurrently */
    skills: string[];
}

export interface BlueprintStepContract {
    input?: ZodType;
    output?: ZodType;
}

export type BlueprintStep<T extends BlueprintContext> =
    | DeterministicStep<T>
    | GateStep<T>
    | LLMStep
    | FormatStep<T>
    | ParallelStep;

// ─── Runner options & result ──────────────────────────────────────────────────

export interface BlueprintRunnerOptions<T extends BlueprintContext> {
    steps: BlueprintStep<T>[];
    context: T;
    /**
     * Called by the runner for each LLMStep.
     * The caller is responsible for:
     * - Loading SKILL.md instructions via SkillLoaderService
     * - Creating/reusing the @kodus/flow agent
     * - Calling orchestration.callAgent()
     * - Writing results back to the returned context
     */
    runLLMStep: (step: LLMStep, ctx: T) => Promise<T>;
    onStepMetric?: (metric: BlueprintStepMetric) => void;
    logger?: {
        log: (msg: string) => void;
        error: (msg: string, err?: unknown) => void;
    };
}

export interface BlueprintStepMetric {
    stepName: string;
    stepType: 'deterministic' | 'gate' | 'llm' | 'format' | 'parallel';
    status: 'success' | 'failed' | 'skipped';
    durationMs: number;
    errorMessage?: string;
}

export interface BlueprintResult<T extends BlueprintContext> {
    /** Final accumulated context after all steps completed (or gate short-circuited) */
    context: T;
    /** Names of steps that ran to completion */
    completedSteps: string[];
    /**
     * Name of the gate step that caused early exit, if any.
     * Present only when execution was short-circuited by a gate step.
     */
    skippedAt?: string;
}
