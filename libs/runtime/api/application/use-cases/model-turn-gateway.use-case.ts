import { createHash, timingSafeEqual } from 'crypto';
import {
    BadGatewayException,
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    Inject,
    Injectable,
    Optional,
    UnauthorizedException,
} from '@nestjs/common';
import {
    parseModelTurnRequest,
    parseModelTurnResponse,
    type ModelTurnRequest,
} from '@libs/runtime/contracts/model-turn';
import {
    canaryKeyFrom,
    containsCanary,
    HmacCanaryVault,
} from '@libs/runtime/canary';
import { openSecret, sealingKeyFrom } from '@libs/runtime/run';
import { redactPatterns } from '@libs/runtime/redaction';
import {
    decideBudget,
    estimateInputTokens,
    planLlmCall,
    startOfUtcDay,
    withOrgBudget,
    type CallPlan,
} from '../../domain/budget';
import {
    RUNTIME_MODEL_TURN_PROVIDER,
    RUNTIME_MODEL_TURN_RECEIPTS,
    type RuntimeModelTurnProvider,
    type RuntimeModelTurnReceipts,
} from '../../domain/model-turn';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_LLM_USAGE_STORE,
    RUNTIME_RUN_PROJECTION_STORE,
    RUNTIME_SETTINGS_STORE,
    type RuntimeApiConfig,
    type Clock,
    type RuntimeLlmUsageStore,
    type RunProjectionReader,
    type RuntimeSettingsStore,
} from '../../domain/ports';
import type { ModelCallBudget } from '@libs/llm/agent-loop-call';
import { modelInputBytes } from '../model-input-bytes';
import {
    runtimeWorkerScope,
    verifyRuntimeWorkerToken,
} from '../runtime-worker-scope';

/** Fixed planner model turns only. No tool callback or model credential crosses this boundary. */
@Injectable()
export class RuntimeModelTurnGatewayUseCase {
    constructor(
        @Inject(RUNTIME_API_CONFIG) private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK) private readonly now: Clock,
        @Inject(RUNTIME_RUN_PROJECTION_STORE)
        private readonly runs: RunProjectionReader,
        @Inject(RUNTIME_LLM_USAGE_STORE)
        private readonly usage: RuntimeLlmUsageStore,
        @Inject(RUNTIME_MODEL_TURN_PROVIDER)
        private readonly provider: RuntimeModelTurnProvider,
        @Inject(RUNTIME_MODEL_TURN_RECEIPTS)
        private readonly receipts: RuntimeModelTurnReceipts,
        @Optional()
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings?: Pick<
            RuntimeSettingsStore,
            'getOrganization'
        >,
    ) {}

    async execute(input: {
        authorization?: string;
        sealedToken?: string;
        body: unknown;
        signal?: AbortSignal;
    }) {
        verifyRuntimeWorkerToken(this.config, this.now, input.authorization);
        let request: ModelTurnRequest;
        try {
            request = parseModelTurnRequest(input.body);
        } catch {
            throw new BadRequestException('Invalid model turn');
        }
        const { claims, run, token } = await runtimeWorkerScope(
            { config: this.config, now: this.now, runs: this.runs },
            input.authorization,
            request.scope,
        );
        const sealedToken = input.sealedToken;
        if (
            !sealedToken ||
            sealedToken.length > 8192 ||
            !this.config.secretSealKey
        )
            throw new UnauthorizedException('Run context required');
        let key: Buffer, opened: string;
        try {
            key = sealingKeyFrom(this.config.secretSealKey);
            opened = openSecret(sealedToken, key, run.runId);
        } catch {
            throw new UnauthorizedException('Invalid Run context');
        }
        const plain = Buffer.from(token),
            context = Buffer.from(opened);
        if (plain.length !== context.length || !timingSafeEqual(plain, context))
            throw new UnauthorizedException('Invalid Run context');
        const serialized = JSON.stringify(request.call);
        const vault = new HmacCanaryVault(canaryKeyFrom(key));
        const canaries = vault.forRun({
            runId: run.runId,
            runToken: sealedToken,
        });
        if (containsCanary(serialized, canaries))
            throw new ForbiddenException({
                code: 'canary_leak',
                where: 'llm_prompt',
                message: 'Runtime security event',
            });
        // Refuse rather than rewrite signed reasoning/tool frames or opaque metadata.
        if (redactPatterns(serialized).count)
            throw new BadRequestException(
                'Model turn contains restricted data',
            );
        input.signal?.throwIfAborted();
        const fingerprint = createHash('sha256')
            .update(JSON.stringify(request))
            .digest('hex');
        const receiptKey = createHash('sha256')
            .update(
                `${claims.organizationId}\0${run.runId}\0${run.attempt}\0${request.scope.turnId}`,
            )
            .digest('hex');
        const receipt = await this.receipts.claim(
            receiptKey,
            fingerprint,
            new Date(this.now().getTime() + 30 * 86400_000),
        );
        if (receipt.fresh === false) {
            if (receipt.fingerprint !== fingerprint || !receipt.response)
                throw new ConflictException({
                    code: 'model_turn_duplicate',
                    message: 'This model turn cannot be executed again',
                });
            return parseModelTurnResponse(receipt.response, request);
        }
        const org = await this.settings?.getOrganization(claims.organizationId);
        const limits = withOrgBudget(
            this.config.llmBudget,
            org?.tokenBudgetPerDay,
        );
        let plan: CallPlan | undefined;
        const reservation = await this.usage.reserve({
            usage: {
                runId: run.runId,
                organizationId: claims.organizationId,
                repositoryId: run.repositoryId,
                prNumber: run.prNumber,
                task: 'runtime.plan',
                at: this.now(),
            },
            orgDayStart: startOfUtcDay(this.now()),
            decide: (spend) => {
                plan = planLlmCall(spend, limits, {
                    runCeiling: claims.maxTokens,
                    inputTokens: estimateInputTokens(serialized.length),
                    requestedOutputTokens: request.call.maxOutputTokens,
                });
                return plan.allowed ? plan.reserve : null;
            },
        });
        if (!reservation || !plan || !plan.allowed)
            throw new HttpException(
                {
                    code: 'llm_budget_exceeded',
                    scope:
                        plan && plan.allowed === false ? plan.exhausted : 'run',
                    message: 'Runtime LLM budget exhausted',
                },
                429,
            );
        const allowed = plan;
        let preflightReleased: Promise<void> | undefined;
        let attempts = 0,
            additionalUsageUnknown = false,
            canaryFound = false,
            budgetRefused = false,
            remainingTokens = allowed.remaining;
        const measuredInput: Record<string, number> = {},
            measuredOutput: Record<string, number> = {};
        const add = (
            target: Record<string, number>,
            source: unknown,
            fields: string[],
        ) => {
            if (!source || typeof source !== 'object') return;
            for (const field of fields) {
                const n = (source as Record<string, unknown>)[field];
                if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
                    target[field] = (target[field] ?? 0) + n;
            }
        };
        const modelCallBudget: ModelCallBudget = {
            before: async (raw) => {
                input.signal?.throwIfAborted();
                const rawInput = {
                    prompt: raw.prompt,
                    ...(raw.tools ? { tools: raw.tools } : {}),
                    ...(raw.providerOptions
                        ? { providerOptions: raw.providerOptions }
                        : {}),
                    ...(raw.responseFormat
                        ? { responseFormat: raw.responseFormat }
                        : {}),
                };
                // UTF-8 bytes plus framing is a conservative token upper bound,
                // including tool JSON and metadata. No chars/3 discount for Unicode.
                const inputTokens = modelInputBytes(rawInput);
                const rawText = JSON.stringify(rawInput);
                if (containsCanary(rawText, canaries)) {
                    canaryFound = true;
                    throw new Error('restricted model attempt');
                }
                if (redactPatterns(rawText).count)
                    throw new Error('restricted model attempt');
                // Concurrent tool repairs wait for the same preflight release;
                // no raw attempt has been permitted when this promise starts.
                preflightReleased ??= this.usage.cancel(
                    reservation.reservationId,
                );
                await preflightReleased;
                let attemptPlan: CallPlan | undefined;
                const held = await this.usage.reserve({
                    usage: {
                        runId: run.runId,
                        organizationId: claims.organizationId,
                        repositoryId: run.repositoryId,
                        prNumber: run.prNumber,
                        task: 'runtime.plan',
                        at: this.now(),
                    },
                    orgDayStart: startOfUtcDay(this.now()),
                    decide: (spend) => {
                        attemptPlan = planLlmCall(spend, limits, {
                            runCeiling: claims.maxTokens,
                            inputTokens,
                            requestedOutputTokens: Math.min(
                                raw.maxOutputTokens ?? allowed.maxOutputTokens,
                                allowed.maxOutputTokens,
                            ),
                        });
                        return attemptPlan.allowed ? attemptPlan.reserve : null;
                    },
                });
                if (!held || !attemptPlan || !attemptPlan.allowed) {
                    budgetRefused = true;
                    throw new HttpException(
                        {
                            code: 'llm_budget_exceeded',
                            message: 'Runtime LLM budget exhausted',
                        },
                        429,
                    );
                }
                const granted = attemptPlan;
                attempts++;
                let finished = false;
                return {
                    maxOutputTokens: granted.maxOutputTokens,
                    finish: async (result) => {
                        if (finished)
                            throw Error('model attempt already finished');
                        finished = true;
                        if (result.outcome === 'not_started') {
                            await this.usage.cancel(held.reservationId);
                            return;
                        }
                        const u = result.usage;
                        if (result.outcome === 'completed' && u) {
                            add(measuredInput, u.inputTokens, [
                                'total',
                                'noCache',
                                'cacheRead',
                                'cacheWrite',
                            ]);
                            add(measuredOutput, u.outputTokens, [
                                'total',
                                'text',
                                'reasoning',
                            ]);
                        }
                        const complete =
                            result.outcome === 'completed' &&
                            u &&
                            Number.isSafeInteger(u.inputTokens?.total) &&
                            u.inputTokens.total! >= 0 &&
                            Number.isSafeInteger(u.outputTokens?.total) &&
                            u.outputTokens.total! >= 0;
                        if (!complete) additionalUsageUnknown = true;
                        const countedInput = complete
                            ? u.inputTokens.total!
                            : held.tokens;
                        const countedOutput = complete
                            ? u.outputTokens.total!
                            : 0;
                        // Unknown consumption keeps the reservation pending. It depletes
                        // admission budgets but never appears as measured model usage.
                        if (complete)
                            await this.usage.settle(held.reservationId, {
                                inputTokens: countedInput,
                                outputTokens: countedOutput,
                                ...(u.inputTokens.cacheRead !== undefined
                                    ? {
                                          cacheReadTokens:
                                              u.inputTokens.cacheRead,
                                      }
                                    : {}),
                                ...(u.inputTokens.cacheWrite !== undefined
                                    ? {
                                          cacheWriteTokens:
                                              u.inputTokens.cacheWrite,
                                      }
                                    : {}),
                                ...(raw.modelId ? { model: raw.modelId } : {}),
                            });
                        remainingTokens = Math.max(
                            0,
                            granted.remaining - countedInput - countedOutput,
                        );
                    },
                };
            },
        };
        try {
            input.signal?.throwIfAborted();
            const result = await this.provider.complete({
                organizationId: claims.organizationId,
                teamId: claims.teamId,
                repositoryId: run.repositoryId,
                runId: run.runId,
                prNumber: run.prNumber,
                request,
                maxOutputTokens: allowed.maxOutputTokens,
                signal: input.signal,
                modelCallBudget,
            });
            if (budgetRefused)
                throw new HttpException(
                    {
                        code: 'llm_budget_exceeded',
                        message: 'Runtime LLM budget exhausted',
                    },
                    429,
                );
            if (!attempts)
                throw Error('provider bypassed model attempt budget');
            const reported =
                Object.keys(measuredInput).length +
                    Object.keys(measuredOutput).length >
                0;
            const generation = {
                ...result.generation,
                usage: reported
                    ? {
                          reported: true as const,
                          inputTokens: measuredInput,
                          outputTokens: measuredOutput,
                      }
                    : { reported: false as const },
            };
            const complete =
                !additionalUsageUnknown &&
                reported &&
                measuredInput.total !== undefined &&
                measuredOutput.total !== undefined;
            // Read the store's current scoped counters after all raw leases
            // settle. A null decision allocates no reservation. A per-attempt
            // `remaining` can be stale after parallel repair settles out of order.
            await this.usage.reserve({
                usage: {
                    runId: run.runId,
                    organizationId: claims.organizationId,
                    repositoryId: run.repositoryId,
                    prNumber: run.prNumber,
                    task: 'runtime.plan',
                    at: this.now(),
                },
                orgDayStart: startOfUtcDay(this.now()),
                decide: (spend) => {
                    const current = decideBudget(
                        spend,
                        limits,
                        claims.maxTokens,
                    );
                    remainingTokens =
                        current.allowed === true ? current.remaining : 0;
                    return null;
                },
            });
            const response = parseModelTurnResponse(
                {
                    v: 1,
                    scope: request.scope,
                    generation,
                    budget: {
                        remainingTokens,
                        usageBasis: complete
                            ? 'provider_reported'
                            : 'reservation',
                        ...(additionalUsageUnknown
                            ? { additionalUsageUnknown: true }
                            : {}),
                    },
                },
                request,
            );
            const encoded = JSON.stringify(response.generation);
            if (containsCanary(encoded, canaries)) {
                canaryFound = true;
                throw new Error('restricted model response');
            }
            if (redactPatterns(encoded).count)
                throw new Error('restricted model response');
            await this.receipts.complete(receiptKey, fingerprint, response);
            return response;
        } catch (e) {
            // Every started raw attempt is already measured or conservatively
            // retained. Pending receipts never authorize another provider call.
            if (canaryFound)
                throw new ForbiddenException({
                    code: 'canary_leak',
                    where: 'llm_prompt',
                    message: 'Runtime security event',
                });
            if (budgetRefused)
                throw new HttpException(
                    {
                        code: 'llm_budget_exceeded',
                        message: 'Runtime LLM budget exhausted',
                    },
                    429,
                );
            if (e instanceof HttpException && e.getStatus() === 429) throw e;
            throw new BadGatewayException({
                code: 'llm_unavailable',
                message: "Kody's model call failed",
            });
        }
    }
}
