import { Inject, Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { RuntimeDefaultBranchPushObservedSchema } from '@libs/runtime/run';

import {
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_RELEASE_GATE,
    type Clock,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RuntimeEnvironmentSetupReader,
    type RuntimeGitPort,
    type RuntimeReleaseGate,
} from '../domain/ports';
import { isSetupInFlight, RUNTIME_PUSH_SETUP_CONFIG, RUNTIME_PUSH_SETUP_LEDGER, setupShaOf, type PushSetupConfig, type PushSetupLedger } from '../domain/push-setup';
import { RuntimeEnvironmentMembers } from './environment-members.service';
import { RuntimeSetupRequester } from './runtime-setup-requester.service';

/** The actor of a setup no person asked for: a push to the default branch. */
const PUSH_SETUP_REQUESTER = { uuid: 'kodus-default-branch-push' };

export type PushSetupSkip =
    | 'invalid_event'
    | 'not_enabled'
    | 'not_default_branch'
    | 'unreadable_head'
    /** A setup of the environment is queued or running (or another replica took the commit): the newest commit waits for it. */
    | 'coalesced'
    /** The environment's setup already is at the commit. */
    | 'already_at_sha'
    /** The environment's setups for today are spent: the commit is dropped; "Set up again" still works. */
    | 'budget_spent';

export type PushSetupOutcome = { action: 'requested'; environmentId: string; sha: string } | { action: 'skipped'; reason: PushSetupSkip; environmentId?: string };

/**
 * docs/runtime/fork-from-checkpoint.md R6: a push to the default branch of a repository that is in a Runtime
 * environment sets that environment up again, so its template is rebuilt and a main baseline suite run is requested
 * for the commit (fleet/template/template-rebuild.ts picks the new active setup up).
 *
 * The push event only says that something happened: that the branch is the default one and what commit it holds are
 * read from the Git API (ADR-057). A PR, a fork, a tag or another branch never gets here (a fork is another
 * repository, which is in no environment). Pushes are coalesced per environment through the ledger: the newest commit
 * is kept as pending, and one setup is asked for it when none is queued or running; the cron drains what a running
 * setup held back. Setups started this way are counted per environment per UTC day (RUNTIME_PUSH_SETUP_DAILY_LIMIT);
 * a manual "Set up again" is never counted. The setup itself is the one the screen asks for (RuntimeSetupRequester),
 * so it is budgeted and blocked like any other.
 */
@Injectable()
export class RuntimeDefaultBranchPushSetup {
    private readonly logger = createLogger(RuntimeDefaultBranchPushSetup.name);

    constructor(
        @Inject(RUNTIME_PUSH_SETUP_LEDGER)
        private readonly ledger: PushSetupLedger,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(RuntimeEnvironmentMembers)
        private readonly members: RuntimeEnvironmentMembers,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: Pick<RuntimeGitPort, 'getDefaultBranchHead'>,
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER)
        private readonly setups: Pick<RuntimeEnvironmentSetupReader, 'get'>,
        @Inject(RuntimeSetupRequester)
        private readonly requester: Pick<RuntimeSetupRequester, 'request'>,
        // Required by Nest; made without it, nothing is released (fails closed).
        @Inject(RUNTIME_RELEASE_GATE)
        private readonly release: RuntimeReleaseGate | undefined,
        @Inject(RUNTIME_PUSH_SETUP_CONFIG)
        private readonly config: PushSetupConfig,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
    ) {}

    /** One push event (the outbox envelope or its payload). A failed setup request throws, so the consumer retries it. */
    async onPush(message: unknown): Promise<PushSetupOutcome[]> {
        const raw = (message as { payload?: unknown })?.payload ?? message;
        const { workflowType: _ignored, ...rest } = (raw ?? {}) as Record<string, unknown>;
        const parsed = RuntimeDefaultBranchPushObservedSchema.safeParse(rest);
        if (!parsed.success) {
            // A malformed event never becomes valid on a retry: drop it instead of dead-lettering it.
            this.logger.warn({
                message: 'Runtime push setup: invalid event dropped',
                context: RuntimeDefaultBranchPushSetup.name,
                metadata: { issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) },
            });
            return [{ action: 'skipped', reason: 'invalid_event' }];
        }
        const ev = parsed.data;
        if (!(await this.release?.isEnabledFor(ev.organizationId))) return [{ action: 'skipped', reason: 'not_enabled' }];

        const memberships = await this.members.environmentsOf(ev.organizationId, ev.repository.id);
        if (!memberships.length) return [];

        const head = await this.git.getDefaultBranchHead({
            organizationId: ev.organizationId,
            teamId: ev.teamId,
            repositoryId: ev.repository.id,
            repositoryName: ev.repository.fullName ?? ev.repository.name,
        });
        if (head.status !== 'ok') {
            this.logger.warn({
                message: 'Runtime push setup: the default branch head could not be read',
                context: RuntimeDefaultBranchPushSetup.name,
                metadata: { organizationId: ev.organizationId, repositoryId: ev.repository.id, status: head.status },
            });
            return [{ action: 'skipped', reason: 'unreadable_head' }];
        }
        if (head.branch !== ev.branch) return [{ action: 'skipped', reason: 'not_default_branch' }];

        const out: PushSetupOutcome[] = [];
        for (const m of memberships) {
            const key = { organizationId: m.env.organizationId, environmentId: m.env.environmentId };
            await this.ledger.markPending(key, head.sha, this.now());
            out.push(await this.settle(m.env, head.sha, { repositoryId: ev.repository.id, isPrimary: m.member.role === 'primary' }));
        }
        return out;
    }

    /**
     * What the pushes held back while a setup ran: for each environment with a pending commit, one setup if none is
     * in flight. Called by the cron; never throws for one environment (it is tried again next tick).
     */
    async drain(limit: number): Promise<{ pending: number; requested: number; skipped: number }> {
        const pending = await this.ledger.listPending(limit);
        let requested = 0;
        let skipped = 0;
        for (const p of pending) {
            try {
                const env = await this.environments.get(p.organizationId, p.environmentId);
                if (!env || !(await this.release?.isEnabledFor(p.organizationId))) {
                    await this.ledger.clearPending(p, p.sha);
                    skipped++;
                    continue;
                }
                const outcome = await this.settle(env, p.sha, { repositoryId: env.repositoryId, isPrimary: true });
                if (outcome.action === 'requested') requested++;
                else if (outcome.reason !== 'coalesced') skipped++;
            } catch (error) {
                this.logger.error({
                    message: 'Runtime push setup: draining an environment failed',
                    context: RuntimeDefaultBranchPushSetup.name,
                    error: error instanceof Error ? error : undefined,
                    metadata: { organizationId: p.organizationId, environmentId: p.environmentId },
                });
            }
        }
        return { pending: pending.length, requested, skipped };
    }

    private async settle(env: ProductEnvironment, sha: string, repo: { repositoryId: string; isPrimary: boolean }): Promise<PushSetupOutcome> {
        const key = { organizationId: env.organizationId, environmentId: env.environmentId };
        const at = this.now();
        const record = await this.setups.get(env.organizationId, env.environmentId);
        const inFlight = isSetupInFlight({ productState: env.state, setupRequestedAt: env.setupRequestedAt, record }, at);
        const bootedAt = setupShaOf(record, repo.repositoryId, repo.isPrimary);
        const skip = (reason: PushSetupSkip): PushSetupOutcome => ({ action: 'skipped', reason, environmentId: env.environmentId });

        // The running setup is enough when it already is at the commit; so is a finished one.
        if (bootedAt === sha && (inFlight ? record?.state === 'setting_up' : record?.state === 'active')) {
            await this.ledger.clearPending(key, sha);
            return skip('already_at_sha');
        }
        // Queued or running at another commit: the newest commit waits as pending and runs once after it.
        if (inFlight) return skip('coalesced');

        const claim = await this.ledger.claim(key, at, this.config.dailyLimit);
        if (claim.status === 'none') return skip('coalesced');
        if (claim.status === 'budget_spent') {
            this.logger.warn({
                message: 'Runtime push setup: the environment spent its setups for today, skipped',
                context: RuntimeDefaultBranchPushSetup.name,
                metadata: { ...key, dailyLimit: this.config.dailyLimit, spentToday: claim.spentToday },
            });
            return skip('budget_spent');
        }
        try {
            await this.requester.request(env, PUSH_SETUP_REQUESTER);
        } catch (error) {
            // The setup did not start: its commit and its place in today's count come back, and the cron tries again.
            await this.ledger.restorePending(key, claim.sha, at).catch(() => undefined);
            throw error;
        }
        this.logger.log({
            message: 'Runtime push setup: requested',
            context: RuntimeDefaultBranchPushSetup.name,
            metadata: { ...key, sha: claim.sha, spentToday: claim.spentToday, dailyLimit: this.config.dailyLimit },
        });
        return { action: 'requested', environmentId: env.environmentId, sha: claim.sha };
    }
}
