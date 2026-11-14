import {
    BadGatewayException,
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    NotFoundException,
    Optional,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';

import { createLogger } from '@libs/core/log/logger';
import { LEARN_TASK } from '@libs/runtime/blockers/hypothesis';
import { redactPatterns } from '@libs/runtime/redaction';
import { isTerminal, setupLearnScopeId } from '@libs/runtime/run';

import { type CallPlan, estimateInputTokens, planLlmCall, setupBudgetLimits, startOfUtcDay, withOrgBudget } from '../../domain/budget';
import { InvalidRunTokenError, isSetupToken, verifyRunToken, verifySetupToken } from '../../domain/run-token';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_LLM_PROVIDER,
    RUNTIME_LLM_USAGE_STORE,
    RUNTIME_RUN_PROJECTION_STORE,
    RUNTIME_SETTINGS_STORE,
    LlmBudgetBusyError,
    LlmProviderUnavailableError,
    type Clock,
    type RunProjectionReader,
    type RuntimeApiConfig,
    type RuntimeEnvironmentSetupReader,
    type RuntimeLlmProvider,
    type RuntimeLlmUsageStore,
    type RuntimeSettingsStore,
} from '../../domain/ports';

export const RuntimeLlmRequestSchema = z.strictObject({
    runId: z.uuid(),
    task: z.string().regex(/^runtime\.[a-z_]{1,32}$/),
    messages: z
        .array(
            z.strictObject({
                role: z.enum(['system', 'user', 'assistant']),
                content: z.string().max(400_000),
            }),
        )
        .min(1)
        .max(200),
    maxOutputTokens: z.number().int().min(1).max(64_000).optional(),
});
export type RuntimeLlmRequest = z.infer<typeof RuntimeLlmRequestSchema>;

const MAX_BODY_CHARS = 2_000_000;

/** The scopes a call is budgeted to: a Run, or a setup's learn loop (prNumber 0 counts all setups of the repo). */
interface BudgetSubject {
    runId: string;
    organizationId: string;
    repositoryId: string;
    prNumber: number;
}

export { LlmProviderUnavailableError };

/**
 * POST /internal/runtime/llm — the LLM gateway of the Runtime (ADR-057). Only
 * the runtime-worker calls it, with the Run token the product signed; the key
 * of the org is decrypted here and never reaches the worker. Budget per Run,
 * per PR and per org per day, reserved before the call (S-47).
 */
@Injectable()
export class RuntimeLlmGatewayUseCase {
    private readonly logger = createLogger(RuntimeLlmGatewayUseCase.name);

    constructor(
        @Inject(RUNTIME_RUN_PROJECTION_STORE)
        private readonly runs: RunProjectionReader,
        @Inject(RUNTIME_LLM_USAGE_STORE)
        private readonly usage: RuntimeLlmUsageStore,
        @Inject(RUNTIME_LLM_PROVIDER)
        private readonly provider: RuntimeLlmProvider,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        @Optional()
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings?: Pick<RuntimeSettingsStore, 'getOrganization'>,
        @Optional()
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER)
        private readonly setups?: RuntimeEnvironmentSetupReader,
    ) {}

    async execute(input: { authorization?: string; body: unknown }) {
        if (!this.config.runTokenSecret) throw new ServiceUnavailableException('Runtime LLM gateway is not configured');

        const token = /^Bearer\s+(\S+)$/i.exec(input.authorization ?? '')?.[1];
        if (!token) throw new UnauthorizedException('Run token required');
        const setupToken = isSetupToken(token);
        let claims: { organizationId: string; teamId: string; maxTokens?: number };
        let runClaims: ReturnType<typeof verifyRunToken> | undefined;
        let setupClaims: ReturnType<typeof verifySetupToken> | undefined;
        try {
            if (setupToken) claims = setupClaims = verifySetupToken(token, this.config.runTokenSecret, this.now());
            else claims = runClaims = verifyRunToken(token, this.config.runTokenSecret, this.now());
        } catch (e) {
            if (e instanceof InvalidRunTokenError) throw new UnauthorizedException(`Invalid ${setupToken ? 'setup' : 'run'} token (${e.reason})`);
            throw e;
        }

        if (JSON.stringify(input.body ?? null).length > MAX_BODY_CHARS) throw new BadRequestException('request too large');
        const parsed = RuntimeLlmRequestSchema.safeParse(input.body);
        if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        const req = parsed.data;

        // Who the call is budgeted to: the Run, or the setup's learn loop under its derived scope id (prNumber 0: the repo's setups).
        const run = runClaims ? await this.runFor(req, runClaims) : await this.setupFor(req, setupClaims!);

        // S-51: the cell already redacted what it knew; the token-pattern net
        // runs again here, on everything the worker puts in the prompt,
        // before it reaches the provider.
        let redactions = 0;
        const byRule: Record<string, number> = {};
        const messages = req.messages.map((m) => {
            const r = redactPatterns(m.content);
            redactions += r.count;
            for (const [rule, n] of Object.entries(r.byRule)) byRule[rule] = (byRule[rule] ?? 0) + n;
            return r.count ? { ...m, content: r.text } : m;
        });
        if (redactions) {
            this.logger.warn({
                message: 'Runtime LLM gateway redacted secrets from the prompt',
                context: RuntimeLlmGatewayUseCase.name,
                metadata: { runId: run.runId, organizationId: run.organizationId, task: req.task, redactions, byRule },
            });
        }

        // S-47: check and reserve in one step, so parallel calls of one org
        // cannot all pass on the same total. The org's own daily budget
        // (Settings) can only lower the gateway's.
        const now = this.now();
        const org = await this.settings?.getOrganization(claims.organizationId);
        const orgLimits = withOrgBudget(this.config.llmBudget, org?.tokenBudgetPerDay);
        // A setup is no pull request: its prNumber 0 counter is the repository's, for good (setupBudgetLimits).
        const limits = setupClaims ? setupBudgetLimits(orgLimits) : orgLimits;
        const inputTokensEstimate = estimateInputTokens(messages.reduce((n, m) => n + m.content.length, 0));
        let plan: CallPlan | undefined;
        const reservation = await this.usage
            .reserve({
            usage: { runId: run.runId, organizationId: run.organizationId, repositoryId: run.repositoryId, prNumber: run.prNumber, task: req.task, at: now },
            orgDayStart: startOfUtcDay(now),
            decide: (spend) => {
                plan = planLlmCall(spend, limits, {
                    runCeiling: claims.maxTokens,
                    inputTokens: inputTokensEstimate,
                    requestedOutputTokens: req.maxOutputTokens,
                });
                return plan.allowed ? plan.reserve : null;
            },
        })
            .catch((e) => {
                if (e instanceof LlmBudgetBusyError) throw new ServiceUnavailableException({ code: 'llm_budget_busy', message: e.message });
                throw e;
            });
        if (!reservation || !plan || plan.allowed === false) {
            const refused = plan && plan.allowed === false ? plan : { exhausted: 'run' as const, spent: 0, limit: 0 };
            this.logger.warn({
                message: 'Runtime LLM budget exhausted',
                context: RuntimeLlmGatewayUseCase.name,
                metadata: { runId: run.runId, organizationId: run.organizationId, scope: refused.exhausted, spent: refused.spent, limit: refused.limit },
            });
            throw new HttpException(
                { statusCode: HttpStatus.TOO_MANY_REQUESTS, code: 'llm_budget_exceeded', scope: refused.exhausted, spent: refused.spent, limit: refused.limit },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }
        const allowed = plan;

        let completion: Awaited<ReturnType<RuntimeLlmProvider['complete']>>;
        try {
            completion = await this.provider.complete({
                organizationId: run.organizationId,
                // The team the product signed into the token, never the Runtime's projection (ADR-052).
                teamId: claims.teamId,
                runId: run.runId,
                repositoryId: run.repositoryId,
                prNumber: run.prNumber,
                task: req.task,
                messages,
                maxOutputTokens: allowed.maxOutputTokens,
            });
        } catch (e) {
            await this.usage.cancel(reservation.reservationId);
            if (e instanceof LlmProviderUnavailableError) throw new ServiceUnavailableException(e.message);
            this.logger.error({
                message: 'Runtime LLM provider call failed',
                context: RuntimeLlmGatewayUseCase.name,
                error: e instanceof Error ? e : undefined,
                metadata: { runId: run.runId, organizationId: run.organizationId },
            });
            throw new BadGatewayException({ code: 'llm_unavailable', message: 'The LLM provider call failed' });
        }

        // A provider that reports no usage keeps the whole reservation counted: settling it at 0
        // would make the call free for every budget scope (S-47).
        const reported = completion.usage;
        const counted = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : undefined);
        const reportedInput = counted(reported?.inputTokens);
        const reportedOutput = counted(reported?.outputTokens);
        let inputTokens: number;
        let outputTokens: number;
        if (reportedInput === undefined || reportedOutput === undefined) {
            inputTokens = reservation.tokens;
            outputTokens = 0;
            this.logger.warn({
                message: 'Runtime LLM provider reported no usage; the reservation stays counted',
                context: RuntimeLlmGatewayUseCase.name,
                metadata: { runId: run.runId, organizationId: run.organizationId, task: req.task, reserved: reservation.tokens },
            });
        } else {
            inputTokens = reportedInput;
            outputTokens = reportedOutput;
        }
        // The cache split and the model only price the Run (its cost); the budget counts input plus output.
        const cacheReadTokens = reportedInput === undefined ? undefined : counted(reported?.cacheReadTokens);
        const cacheWriteTokens = reportedInput === undefined ? undefined : counted(reported?.cacheWriteTokens);
        await this.usage.settle(reservation.reservationId, {
            inputTokens,
            outputTokens,
            ...(cacheReadTokens ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
            ...(completion.model ? { model: completion.model } : {}),
        });

        return {
            text: completion.text,
            usage: { inputTokens, outputTokens },
            budget: { remaining: Math.max(0, allowed.remaining - inputTokens - outputTokens) },
            redactions,
        };
    }

    private async runFor(req: RuntimeLlmRequest, claims: ReturnType<typeof verifyRunToken>): Promise<BudgetSubject> {
        if (req.runId !== claims.runId) throw new ForbiddenException('The run token is for another Run');
        const run = await this.runs.get(req.runId, { organizationId: claims.organizationId });
        if (!run || run.organizationId !== claims.organizationId) throw new NotFoundException('Run not found');
        if (run.attempt !== claims.attempt) throw new ForbiddenException('The run token is for another attempt');
        if (isTerminal(run.state)) throw new ConflictException('The Run has finished');
        return { runId: run.runId, organizationId: run.organizationId, repositoryId: run.repositoryId, prNumber: run.prNumber };
    }

    /**
     * A setup token only serves the learn loop of the environment's latest
     * setup: a newer setup supersedes it, so an old token cannot keep spending.
     */
    private async setupFor(req: RuntimeLlmRequest, claims: ReturnType<typeof verifySetupToken>): Promise<BudgetSubject> {
        if (req.task !== LEARN_TASK) throw new ForbiddenException('A setup token is only for the learn loop');
        if (req.runId !== setupLearnScopeId(claims.setupKey)) throw new ForbiddenException('The setup token is for another setup');
        if (!this.setups) throw new ServiceUnavailableException('Runtime LLM gateway is not configured for setups');
        const setup = await this.setups.get(claims.organizationId, claims.environmentId);
        if (!setup || setup.organizationId !== claims.organizationId || setup.environmentId !== claims.environmentId) {
            throw new NotFoundException('Setup not found');
        }
        if (setup.key !== claims.setupKey || setup.repositoryId !== claims.repositoryId) {
            throw new ConflictException('A newer setup of this environment replaced this one');
        }
        // The loop only runs on a setup that ended blocked.
        if (setup.state !== 'blocked') throw new ConflictException('This setup is not blocked');
        return { runId: req.runId, organizationId: claims.organizationId, repositoryId: claims.repositoryId, prNumber: 0 };
    }
}
