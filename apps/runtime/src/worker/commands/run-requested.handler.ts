import { Logger } from '@nestjs/common';

import {
    RuntimeEventName,
    RuntimeRunCancelRequestedSchema,
    type RuntimeRunProjection,
    RuntimeRunRequested,
    RuntimeRunRequestedSchema,
    isTerminal,
    type RunProjectionStore,
} from '@libs/runtime/run';
import { withRunSpan } from '@libs/runtime/telemetry';

import type { PrAdmissionStore, PrAdmissionDecision, RunDeliveryContext } from '../../shared/pr-admission-store';
import type { DistributedLocks } from '../../shared/locks';
import { readyTarget } from '../env/ready-check';
import { recipeChangedInPr } from '../run/recipe-change';
import type { CommandStore } from '../../shared/pg-command-store';
import type { EnvironmentSetupStore } from '../setup/environment-setup.store';
import type { CommandHandler, HandlerResult } from './command-handlers';
import type { RunEngine } from './run-engine.port';

/** One lock per PR: the start/supersede decision runs on one worker at a time, cluster-wide. */
export const prLockKey = (r: { organizationId: string; repositoryId: string; prNumber: number }) => `run:${r.organizationId}:${r.repositoryId}:${r.prNumber}`;

/** RuntimeRunRequested: supersede older heads, keep one live Run per SHA, enqueue. */
export class RunRequestedHandler implements CommandHandler {
    readonly event = RuntimeEventName.RunRequested;
    private readonly logger = new Logger('RunRequested');

    constructor(
        private readonly engine: RunEngine,
        private readonly projection: RunProjectionStore,
        private readonly commands: CommandStore,
        private readonly locks: DistributedLocks,
        private readonly admissions: PrAdmissionStore,
        private readonly setups?: Pick<EnvironmentSetupStore, 'get'>,
        /** RUNTIME_SETUP_HEALTH_PATH: the ready path when the recipe names none, as the setup's. */
        private readonly opts: { healthPath?: string } = {},
    ) {}

    async handle(body: Record<string, unknown>, delivery?: RunDeliveryContext): Promise<HandlerResult> {
        const parsed = RuntimeRunRequestedSchema.safeParse(body);
        // A malformed message goes to the DLQ instead of looping (requeue false).
        if (!parsed.success) return { invalid: 'invalid RuntimeRunRequested', detail: parsed.error.message };
        return this.requested(parsed.data, delivery);
    }

    /**
     * A Run boots with what the environment's setup recorded from the default
     * branch (§6), the Runtime's own record: its expose list and machine size
     * replace the request's, and the PR's copy of the recipe is never used. A store that
     * cannot be read fails the message (it is retried), never falls back.
     * With no active setup of this org and repository, the product's
     * resolution in the request stands.
     */
    private async withRecordedRecipe(req: RuntimeRunRequested): Promise<{ req: RuntimeRunRequested; recipe?: RuntimeRunProjection['recipe'] }> {
        // The size comes only from a setup record (the schema: never the product's); without one the cell's default applies.
        if (req.environment.size || req.environment.ready) {
            const { size: _ignored, ready: _notTheProducts, ...environment } = req.environment;
            req = { ...req, environment };
        }
        // Authored files come only from the setup's record, never from the request (the product's, or anything a PR could steer).
        if (req.environment.recipe?.files) {
            const { files: _dropped, ...recipe } = req.environment.recipe;
            req = { ...req, environment: { ...req.environment, recipe } };
        }
        if (!this.setups) return { req };
        const setup = await this.setups.get(req.environment.environmentId);
        if (!setup || setup.organizationId !== req.organizationId || setup.repositoryId !== req.repository.id || setup.state !== 'active') {
            this.logger.log({ msg: 'run.no_active_setup', runId: req.runId, environmentId: req.environment.environmentId });
            return { req };
        }
        // The cell boots with this recipe, not with the PR's copy (§6).
        const forClaim = setup.recipe
            ? {
                  path: setup.recipe.path,
                  content: setup.recipe.state === 'found' && typeof setup.recipe.content === 'string' ? setup.recipe.content : null,
                  ...(setup.recipe.digest ? { digest: setup.recipe.digest } : {}),
                  // Kody's build files, from the default branch's authored submission the setup booted: the PR's checkout never supplies them.
                  ...(setup.recipe.state === 'found' && typeof setup.recipe.content === 'string' && setup.recipe.files?.length ? { files: setup.recipe.files } : {}),
              }
            : undefined;
        const environment: RuntimeRunRequested['environment'] = { ...req.environment, ...(setup.expose?.length ? { expose: setup.expose } : {}), ...(forClaim ? { recipe: forClaim } : {}) };
        const prChangesRecipe = recipeChangedInPr({ ...req, environment }).length > 0;
        const recipe = setup.recipe ? { sha: setup.recipe.sha, state: setup.recipe.state, ...(setup.recipe.digest ? { digest: setup.recipe.digest } : {}), prChangesRecipe } : undefined;
        // The Run boots at the size its setup booted with, never at one the request names.
        if (setup.machineSize) environment.size = setup.machineSize;
        // The ready check the setup passed, so a Run waits for the app after each reset as the setup did after its boot.
        const ready = readyTarget(environment.expose, setup.recipe ?? {}, this.opts.healthPath);
        if (ready) environment.ready = { ...ready, waitSeconds: Math.ceil(ready.waitSeconds) };
        return { req: { ...req, environment }, recipe };
    }

    /** An accepted external task must observe a terminal result even if no workflow starts. */
    private async refuseExternal(req: RuntimeRunRequested, reason: 'external_verification_head_busy' | 'external_verification_stopped'): Promise<void> {
        if (req.trigger !== 'external_finding') return;
        await this.projection.upsert(req.runId, {
            attempt: req.attempt, correlationId: req.correlationId, organizationId: req.organizationId, teamId: req.teamId,
            repositoryId: req.repository.id, repositoryName: req.repository.name, prNumber: req.pullRequest.number,
            trigger: req.trigger, headSha: req.pullRequest.headSha, baseSha: req.pullRequest.baseSha,
            ...(req.pullRequest.baseBranch === undefined ? {} : { baseBranch: req.pullRequest.baseBranch }),
            environmentId: req.environment.environmentId, imageId: req.environment.imageId,
            state: 'skipped', reason, requestedAt: req.requestedAt, finishedAt: new Date().toISOString(),
        });
    }

    private async refuseObsolete(req: RuntimeRunRequested, refusal: Exclude<PrAdmissionDecision, { accepted: true }>): Promise<HandlerResult> {
        const existing = await this.projection.get(req.runId, { organizationId: req.organizationId });
        if (!existing || !isTerminal(existing.state)) {
            const state = refusal.reason === 'superseded' ? 'superseded' : 'cancelled';
            if (existing) {
                // The engine owns publish-start/cancel arbitration. Never overwrite its terminal result.
                await this.engine.stop({ runId: req.runId, attempt: req.attempt, organizationId: req.organizationId, correlationId: req.correlationId, headSha: req.pullRequest.headSha }, state, `pr_admission_${refusal.reason}`);
            } else {
                await this.projection.upsert(req.runId, {
                    organizationId: req.organizationId, teamId: req.teamId, repositoryId: req.repository.id,
                    repositoryName: req.repository.name, prNumber: req.pullRequest.number, headSha: req.pullRequest.headSha,
                    baseSha: req.pullRequest.baseSha, environmentId: req.environment.environmentId, imageId: req.environment.imageId,
                    ...(req.pullRequest.baseBranch === undefined ? {} : { baseBranch: req.pullRequest.baseBranch }),
                    correlationId: req.correlationId, attempt: req.attempt, trigger: req.trigger, requestedAt: req.requestedAt,
                    state, reason: `pr_admission_${refusal.reason}`, finishedAt: new Date().toISOString(),
                });
            }
        }
        if (refusal.reason === 'unknown_redelivery') return { invalid: 'unknown_redelivery', detail: 'pr_admission_unknown_redelivery' };
    }

    async requested(incoming: RuntimeRunRequested, delivery?: RunDeliveryContext): Promise<HandlerResult> {
        const scope = { organizationId: incoming.organizationId, repositoryId: incoming.repository.id, prNumber: incoming.pullRequest.number };
        const key = prLockKey(scope);
        const registration = await this.locks.withLock(key, () => this.admissions.register(scope, incoming.runId, incoming.pullRequest.headSha, delivery?.redelivered ?? false));
        if ('reason' in registration) return this.locks.withLock(key, () => this.refuseObsolete(incoming, registration));
        // Do slow setup IO outside the PR lock, then recheck the durable generation before effects.
        const { req, recipe } = await this.withRecordedRecipe(incoming);
        const changedRecipe = recipeChangedInPr(req);
        return withRunSpan('runtime.run.requested', req.correlationId, { 'runtime.run.id': req.runId, 'runtime.org.id': req.organizationId }, () =>
            this.locks.withLock(key, async () => {
                const authority = await this.admissions.current(scope, req.runId);
                if ('reason' in authority) return this.refuseObsolete(req, authority);
                const existing = await this.projection.get(req.runId, { organizationId: req.organizationId });
                if (existing && isTerminal(existing.state)) return;
                // A new head supersedes the live Runs of older SHAs of the same PR (ADR-011).
                const live = await this.projection.findLive({ organizationId: req.organizationId, repositoryId: req.repository.id, prNumber: req.pullRequest.number });
                for (const old of live.filter((r) => r.runId !== req.runId && r.headSha !== req.pullRequest.headSha)) {
                    await this.engine.stop(
                        { runId: old.runId, attempt: old.attempt, organizationId: old.organizationId, correlationId: old.correlationId, headSha: old.headSha },
                        'superseded',
                        `new head ${req.pullRequest.headSha.slice(0, 12)}`,
                    );
                }
                // One live Run per org, repo, PR and SHA (ADR-057).
                if (live.some((r) => r.runId !== req.runId && r.headSha === req.pullRequest.headSha)) {
                    this.logger.warn({ msg: 'run.ignored', runId: req.runId, why: 'a Run for this head is still live', headSha: req.pullRequest.headSha.slice(0, 12) });
                    await this.refuseExternal(req, 'external_verification_head_busy');
                    return;
                }
                if (await this.commands.isStopped(req.organizationId)) {
                    this.logger.warn({ msg: 'run.refused', runId: req.runId, why: 'the Runtime is stopped for this org', organizationId: req.organizationId });
                    await this.refuseExternal(req, 'external_verification_stopped');
                    return;
                }
                if (!(await this.projection.get(req.runId, { organizationId: req.organizationId }))) {
                    await this.projection.upsert(req.runId, {
                        attempt: req.attempt,
                        correlationId: req.correlationId,
                        organizationId: req.organizationId,
                        teamId: req.teamId,
                        repositoryId: req.repository.id,
                        repositoryName: req.repository.name,
                        prNumber: req.pullRequest.number,
                        trigger: req.trigger,
                        headSha: req.pullRequest.headSha,
                        baseSha: req.pullRequest.baseSha,
                        ...(req.pullRequest.baseBranch === undefined ? {} : { baseBranch: req.pullRequest.baseBranch }),
                        environmentId: req.environment.environmentId,
                        imageId: req.environment.imageId,
                        ...(recipe ? { recipe } : {}),
                        ...(changedRecipe.length ? { recipeChangedInPr: changedRecipe } : {}),
                        state: 'queued',
                        requestedAt: req.requestedAt,
                    });
                }
                await this.engine.start(req);
                this.logger.log({ msg: 'run.enqueued', runId: req.runId, organizationId: req.organizationId });
            }),
        );
    }
}

/** RuntimeRunCancelRequested: the PR closed, or the product superseded it. */
export class RunCancelRequestedHandler implements CommandHandler {
    readonly event = RuntimeEventName.RunCancelRequested;

    constructor(
        private readonly engine: Pick<RunEngine, 'stop'>,
        private readonly projection: RunProjectionStore,
        private readonly locks: DistributedLocks,
        private readonly admissions: PrAdmissionStore,
    ) {}

    async handle(body: Record<string, unknown>, delivery?: RunDeliveryContext): Promise<HandlerResult> {
        const parsed = RuntimeRunCancelRequestedSchema.safeParse(body);
        if (!parsed.success) return { invalid: 'invalid RuntimeRunCancelRequested', detail: parsed.error.message };
        if (!delivery?.messageId) return { invalid: 'missing_cancel_identity', detail: 'missing_cancel_identity' };
        const c = parsed.data;
        await this.locks.withLock(prLockKey(c), async () => {
            const keepHead = c.reason === 'superseded' ? c.headSha : undefined;
            const ceiling = await this.admissions.cancel(c, delivery.messageId!, keepHead, delivery.redelivered);
            const live = await this.projection.findLive({ organizationId: c.organizationId, repositoryId: c.repositoryId, prNumber: c.prNumber });
            for (const r of live.filter((x) => !keepHead || x.headSha !== keepHead)) {
                if (!(await this.admissions.canCancel(c, r.runId, ceiling))) continue;
                await this.engine.stop(
                    { runId: r.runId, attempt: r.attempt, organizationId: r.organizationId, correlationId: r.correlationId, headSha: r.headSha },
                    c.reason === 'superseded' ? 'superseded' : 'cancelled',
                    c.reason,
                );
            }
        });
    }
}
