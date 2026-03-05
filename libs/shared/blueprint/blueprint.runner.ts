import {
    BlueprintContext,
    BlueprintStepContract,
    BlueprintResult,
    BlueprintRunnerOptions,
} from './blueprint.types';

export class BlueprintStepContractViolationError extends Error {
    constructor(
        readonly stepName: string,
        readonly stage: 'input' | 'output',
        readonly details: string,
    ) {
        super(
            `[blueprint] Step '${stepName}' failed ${stage} contract validation: ${details}`,
        );
        this.name = 'BlueprintStepContractViolationError';
    }
}

function validateContract<T extends BlueprintContext>(
    stepName: string,
    stage: 'input' | 'output',
    contract: BlueprintStepContract | undefined,
    ctx: T,
): T {
    const schema = stage === 'input' ? contract?.input : contract?.output;
    if (!schema) {
        return ctx;
    }

    const parsed = schema.safeParse(ctx);
    if (!parsed.success) {
        const details = parsed.error.issues
            .map(
                (issue) =>
                    `${issue.path.join('.') || '<root>'}: ${issue.message}`,
            )
            .join('; ');
        throw new BlueprintStepContractViolationError(stepName, stage, details);
    }

    return parsed.data as T;
}

/**
 * runBlueprint — Execute a skill blueprint against an initial context.
 *
 * Pure async function — no NestJS or @kodus/flow dependencies.
 * Each step type is handled as follows:
 *
 * - `deterministic`: await step.fn(ctx), replace ctx with result
 * - `gate`: if condition(ctx) is false → call onFail(ctx), return early with skippedAt set
 * - `llm`: delegate to options.runLLMStep(step, ctx); caller owns the @kodus/flow call
 * - `format`: step.fn(ctx), replace ctx with result (sync)
 * - `parallel`: not handled here — caller must handle via ISkillRunner.runParallel()
 *
 * Any step error propagates to the caller (no silent swallowing).
 */
export async function runBlueprint<T extends BlueprintContext>(
    options: BlueprintRunnerOptions<T>,
): Promise<BlueprintResult<T>> {
    let ctx = options.context;
    const completedSteps: string[] = [];
    const log = options.logger;
    const onStepMetric = options.onStepMetric;

    for (const step of options.steps) {
        const startedAt = Date.now();
        const emitMetric = (
            status: 'success' | 'failed' | 'skipped',
            errorMessage?: string,
        ) => {
            onStepMetric?.({
                stepName: step.name,
                stepType: step.type,
                status,
                durationMs: Date.now() - startedAt,
                ...(errorMessage ? { errorMessage } : {}),
            });
        };

        log?.log(`[blueprint] running step: ${step.name} (${step.type})`);

        try {
            ctx = validateContract(step.name, 'input', step.contract, ctx);

            if (step.type === 'deterministic') {
                ctx = await step.fn(ctx);
                ctx = validateContract(step.name, 'output', step.contract, ctx);
                completedSteps.push(step.name);
                emitMetric('success');
            } else if (step.type === 'gate') {
                const passed = step.condition(ctx);
                if (!passed) {
                    log?.log(
                        `[blueprint] gate '${step.name}' failed — short-circuiting`,
                    );
                    ctx = step.onFail(ctx);
                    ctx = validateContract(
                        step.name,
                        'output',
                        step.contract,
                        ctx,
                    );
                    emitMetric('skipped');
                    return {
                        context: ctx,
                        completedSteps,
                        skippedAt: step.name,
                    };
                }
                ctx = validateContract(step.name, 'output', step.contract, ctx);
                completedSteps.push(step.name);
                emitMetric('success');
            } else if (step.type === 'llm') {
                ctx = await options.runLLMStep(step, ctx);
                ctx = validateContract(step.name, 'output', step.contract, ctx);
                completedSteps.push(step.name);
                emitMetric('success');
            } else if (step.type === 'format') {
                ctx = step.fn(ctx);
                ctx = validateContract(step.name, 'output', step.contract, ctx);
                completedSteps.push(step.name);
                emitMetric('success');
            } else if (step.type === 'parallel') {
                // Parallel steps are not handled by the runner — they require ISkillRunner.
                // If encountered here it means the blueprint was wired incorrectly.
                throw new Error(
                    `[blueprint] Parallel step '${(step as any).name}' cannot be executed by runBlueprint directly. ` +
                        `Use ISkillRunner.runParallel() instead.`,
                );
            }
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            emitMetric('failed', errorMessage);
            throw error;
        }
    }

    return { context: ctx, completedSteps };
}
