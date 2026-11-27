import {
    BadGatewayException,
    BadRequestException,
    ForbiddenException,
    Inject,
    Injectable,
    Optional,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { type RunPlanResponse, RunPlanRequestSchema } from '@libs/runtime/contracts/run-plan';

import { decideBudget, tightestBudgetScope } from '../../domain/budget';
import {
    RUNTIME_AGENT_RUNNER_FACTORY,
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_GIT_PORT,
    RUNTIME_LLM_USAGE_STORE,
    RUNTIME_RUN_PROJECTION_STORE,
    RUNTIME_SETTINGS_STORE,
    type Clock,
    type RunProjectionReader,
    type RuntimeAgentRunnerFactory,
    type RuntimeApiConfig,
    type RuntimeGitPort,
    type RuntimeLlmUsageStore,
    type RuntimeSettingsStore,
} from '../../domain/ports';
import { InvalidRunTokenError, isSetupToken, verifyRunToken } from '../../domain/run-token';
import { withFailureContext } from '../failure-context';
import { GitRepoReader } from '../recipe-author/git-repo-reader';
import { type BudgetRefusal, liveRunFor, llmBudgetExceeded, orgLlmBudget, reservationFor, type ReservationRequest, withReservation } from '../llm-run-budget';
import { planWithoutModel } from '@libs/runtime/planner/plan-without-model';
import { planTests, plannerRoundTokens } from '@libs/runtime/planner/test-planner.agent';

/** The task the Run's budget counts the planner's tokens under (the worker's 2-turn plan used the same). */
export const TEST_PLANNER_TASK = 'runtime.plan';
/** Tokens the Run's budget must still have for a round to start: below it the agent could not read and submit. */
export const TEST_PLANNER_MIN_TOKENS = 20_000;
/** One round, model calls and Git reads, stops here. */
export const TEST_PLANNER_TIMEOUT_MS = 4 * 60_000;
export const TEST_PLANNER_UNAVAILABLE = { code: 'llm_unavailable', message: "Kody's model call failed" } as const;

const MAX_BODY_CHARS = 200_000;
const counted = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : undefined);

/**
 * POST /internal/runtime/plan. The worker's `agent:plan` step asks
 * the product to plan the Run's probes, with the Run token. The agent runs
 * here, on the org's LLM_TASK.runtime slot, and the key never reaches the
 * worker or the cell. It reads the base commit the Run projection
 * records, through the Git integration, and the changed files at the head;
 * the commands it wants on the base machine go back to the worker, which runs
 * them as exec steps and calls again. Each round's tokens are reserved under
 * the Run's budget scopes before it starts and settled with what the model
 * reported.
 */
@Injectable()
export class RuntimeTestPlannerUseCase {
    private readonly logger = createLogger(RuntimeTestPlannerUseCase.name);

    constructor(
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        @Inject(RUNTIME_RUN_PROJECTION_STORE)
        private readonly runs: RunProjectionReader,
        @Inject(RUNTIME_LLM_USAGE_STORE)
        private readonly usage: RuntimeLlmUsageStore,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: RuntimeGitPort,
        @Inject(RUNTIME_AGENT_RUNNER_FACTORY)
        private readonly runners: RuntimeAgentRunnerFactory,
        @Optional()
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings?: Pick<RuntimeSettingsStore, 'getOrganization'>,
    ) {}

    async execute(input: { authorization?: string; body: unknown; signal?: AbortSignal }): Promise<RunPlanResponse> {
        if (!this.config.runTokenSecret) throw new ServiceUnavailableException('Runtime test planner is not configured');
        const token = /^Bearer\s+(\S+)$/i.exec(input.authorization ?? '')?.[1];
        if (!token) throw new UnauthorizedException('Run token required');
        // Only a Run token: a setup plans no probes.
        if (isSetupToken(token)) throw new UnauthorizedException('Invalid run token (a setup token)');
        let claims: ReturnType<typeof verifyRunToken>;
        try {
            claims = verifyRunToken(token, this.config.runTokenSecret, this.now());
        } catch (e) {
            if (e instanceof InvalidRunTokenError) throw new UnauthorizedException(`Invalid run token (${e.reason})`);
            throw e;
        }

        if (JSON.stringify(input.body ?? null).length > MAX_BODY_CHARS) throw new BadRequestException('request too large');
        const parsed = RunPlanRequestSchema.safeParse(input.body);
        if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        const req = parsed.data;

        const run = await liveRunFor(this.runs, claims, req.runId);
        if (run.repositoryId !== claims.repositoryId) throw new ForbiddenException('The run token is for another repository');

        // Nothing the diff changed has behavior to probe (only the recipe, lockfiles or docs): no
        // model call and no tokens, an empty plan the worker checks as any other.
        if (!req.entryPoints.length) {
            return { status: 'planned', plan: { probes: [], tests: [], claims: [], cannotProve: [] }, rejected: [], usage: { inputTokens: 0, outputTokens: 0 }, steps: 0 };
        }
        // Only dependency versions or comments moved: nothing a targeted probe reaches. Each file goes in
        // cannotProve with why, and no model call is made (plan-without-model.ts).
        const planned = planWithoutModel(req);
        if (planned) return { status: 'planned', plan: planned, rejected: [], usage: { inputTokens: 0, outputTokens: 0 }, steps: 0 };

        // The team the product signed into the token, never the Runtime's projection.
        const orgTeam = { organizationId: claims.organizationId, teamId: claims.teamId };
        const agent = await this.runners.forOrganization(orgTeam, { runId: run.runId, task: TEST_PLANNER_TASK, repositoryId: run.repositoryId, environmentId: run.environmentId, prNumber: run.prNumber });
        if (!agent) throw new ServiceUnavailableException('No LLM is configured for the Kody Runtime of this organization');

        // Reserve the round's tokens up front under the Run's scopes; the round never spends past it.
        const limits = await orgLlmBudget(this.config, this.settings, claims.organizationId);
        let refused: BudgetRefusal | undefined;
        const decide = (spend: Parameters<ReservationRequest['decide']>[0]) => {
            const d = decideBudget(spend, limits, claims.maxTokens);
            if (d.allowed === false) {
                refused = d;
                return null;
            }
            const tokens = Math.min(plannerRoundTokens(req.round), d.remaining);
            if (tokens < TEST_PLANNER_MIN_TOKENS) {
                refused = tightestBudgetScope(spend, limits, claims.maxTokens);
                return null;
            }
            return tokens;
        };
        const target = { ...orgTeam, repositoryId: run.repositoryId, repositoryName: run.repositoryName };
        const round = await withReservation(
            this.usage,
            reservationFor({ ...run, task: TEST_PLANNER_TASK }, this.now(), decide),
            async (reservation) => {
                const base = new GitRepoReader(this.git, { ...target, sha: run.baseSha });
                const head = new GitRepoReader(this.git, { ...target, sha: run.headSha });
                const timeout = AbortSignal.timeout(TEST_PLANNER_TIMEOUT_MS);
                try {
                    return await planTests(
                        { runner: agent.runner, base, head },
                        {
                            runId: run.runId,
                            repositoryName: run.repositoryName,
                            baseSha: run.baseSha,
                            request: req,
                            maxTokens: reservation.tokens,
                            signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
                        },
                    );
                } catch (e) {
                    // Logged once, by the API's exception filter: the 502 carries the ids and the round's error as its cause.
                    throw withFailureContext(new BadGatewayException(TEST_PLANNER_UNAVAILABLE), { runId: run.runId, organizationId: run.organizationId, round: req.round }, e);
                }
            },
            // What a failed round spent before it failed is unknown: the reservation stays counted.
            { onFailure: 'count_reserved', busyAsUnavailable: true, model: agent.model },
        );
        if (!round.reserved) {
            const r = refused ?? { exhausted: 'run', spent: 0, limit: 0 };
            // The scope, spent and limit ride in the 429's body; the API's exception filter logs it with the ids.
            throw withFailureContext(llmBudgetExceeded(r), { runId: run.runId, organizationId: run.organizationId });
        }
        const { reservation, value: result } = round;

        const inputTokens = counted(result.usage.inputTokens);
        const outputTokens = counted(result.usage.outputTokens);
        // A provider that reports nothing keeps the reservation counted, never a free round.
        const usage = inputTokens || outputTokens ? { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 } : { inputTokens: reservation.tokens, outputTokens: 0 };
        await this.usage
            .settle(reservation.reservationId, { ...usage, ...(agent.model ? { model: agent.model } : {}) })
            .catch((err: unknown) =>
                this.logger.error({
                    message: 'Runtime test planner: settling the round failed; the reservation stays counted',
                    context: RuntimeTestPlannerUseCase.name,
                    error: err instanceof Error ? err : undefined,
                    metadata: { runId: run.runId, organizationId: run.organizationId, reserved: reservation.tokens },
                }),
            );

        const { runStatus, ...answer } = result;
        // The model failed before Kody submitted anything: no plan of Kody's, the Run errors as on any LLM failure.
        if (answer.status === 'no_plan' && runStatus === 'error') throw new BadGatewayException(TEST_PLANNER_UNAVAILABLE);
        this.logger.log({
            message: 'Runtime test planner round finished',
            context: RuntimeTestPlannerUseCase.name,
            metadata: {
                runId: run.runId,
                organizationId: run.organizationId,
                round: req.round,
                status: answer.status,
                steps: answer.steps,
                ...(answer.status === 'planned' ? { probes: answer.plan.probes.length, rejected: answer.rejected.length } : {}),
                ...(answer.status === 'explore' ? { commands: answer.commands.length } : {}),
                ...usage,
            },
        });
        return { ...answer, usage };
    }
}
