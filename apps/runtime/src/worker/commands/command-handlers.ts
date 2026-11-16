import type { RunDeliveryContext } from '../../shared/admission/pr-admission-store';
import { Logger } from '@nestjs/common';

import {
    RuntimeCellRevokeRequestedSchema,
    RuntimeCellTokenIssuedSchema,
    RuntimeCellTokenRevokedSchema,
    RuntimeCommandName,
    RuntimeEgressApprovedSchema,
    RuntimeEgressRevokedSchema,
    RuntimeEgressSettingsChangedSchema,
    RuntimeLessonUpdateRequestedSchema,
    RuntimeEnvironmentPoolRequestedSchema,
    RuntimeEnvironmentSetupRequestedSchema,
    RuntimeForkApprovedSchema,
    RuntimeStopClearedSchema,
    RuntimeStopRequestedSchema,
} from '@libs/runtime/contracts/runtime-commands';
import type { MachineSize } from '@libs/runtime/contracts/machine-size';
import { RECOMMENDED_EGRESS_VERSION } from '@libs/runtime/protocol/egress-catalog';
import type { RunProjectionStore } from '@libs/runtime/run';

import type { CommandStore } from '../../shared/persistence/pg-command-store';
import type { SealedSecretOpener } from '../secrets/sealed-tokens';
import type { LessonStore } from '../setup/lesson.store';
import { sealedForInput, setupTokenBinding } from '../secrets/sealed-tokens';
import type { RunEngine } from './run-engine.port';

// The commands the API sends through the outbox (it never writes the Runtime
// database), one handler each. A handler returns 'invalid' with the reason
// for a message that must go to the dead-letter queue.

export type HandlerResult = void | { invalid: string; detail: string };
export interface CommandHandler {
    readonly event: string;
    handle(body: Record<string, unknown>, delivery?: RunDeliveryContext): Promise<HandlerResult>;
}

const invalid = (what: string, detail: string): HandlerResult => ({ invalid: what, detail });
/** The org of an org-scoped stop; undefined for a global one. */
const orgOf = (d: { scope: 'org'; organizationId: string } | { scope: 'global' }) => (d.scope === 'org' ? d.organizationId : undefined);

export class ForkApprovedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.ForkApproved;
    private readonly logger = new Logger('ForkApproved');
    constructor(
        private readonly projection: RunProjectionStore,
        private readonly commands: CommandStore,
        private readonly engine: Pick<RunEngine, 'approve'>,
    ) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeForkApprovedSchema.safeParse(body);
        if (!p.success) return invalid('invalid fork approval', p.error.message);
        const run = await this.projection.get(p.data.runId);
        // The approval is bound to the Run's own head and org, never to what the message says alone.
        if (!run || run.organizationId !== p.data.organizationId || run.headSha !== p.data.headSha || run.attempt !== p.data.attempt) {
            this.logger.warn({ msg: 'fork_approval.ignored', key: p.data.key, why: 'does not match the Run record' });
            return;
        }
        await this.commands.recordForkApproval({ key: p.data.key, runId: run.runId, headSha: run.headSha, approver: p.data.approver.userId, approvedAt: p.data.approvedAt });
        await this.engine.approve(run.runId, run.headSha, p.data.key, p.data.tokens);
    }
}

/** Sends an environment's allowlist to the hub replicas that hold its live claims. */
export interface EgressPolicyPusher {
    push(organizationId: string, environmentId: string, allow: string[]): Promise<void>;
}

export class EgressApprovedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.EgressApproved;
    private readonly logger = new Logger('EgressApproved');
    constructor(
        private readonly commands: CommandStore,
        private readonly egress?: EgressPolicyPusher,
    ) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeEgressApprovedSchema.safeParse(body);
        if (!p.success) return invalid('invalid egress approval', p.error.message);
        const d = p.data;
        const mode = d.mode ?? 'passthrough';
        await this.commands.recordEgressApproval({
            environmentId: d.environmentId, host: d.host, organizationId: d.organizationId, approvedBy: d.approvedBy.userId, approvedAt: d.approvedAt,
            mode, ...(mode === 'inspected' ? { pathPrefixes: d.pathPrefixes } : {}), source: d.source ?? 'blocker',
        });
        // Who, when, which tier and from where (G4): the environment page shows it.
        await this.commands.recordEgressAudit({
            key: d.key + '@' + d.approvedAt, organizationId: d.organizationId, environmentId: d.environmentId, host: d.host, action: 'approve', mode,
            ...(mode === 'inspected' ? { pathPrefixes: d.pathPrefixes } : {}), actor: d.approvedBy.userId, source: d.source ?? 'blocker',
            ...(d.sourceRef ? { sourceRef: d.sourceRef } : {}), ...(d.reason ? { reason: d.reason } : {}), recommendedVersion: RECOMMENDED_EGRESS_VERSION, at: d.approvedAt,
        });
        await pushEgress(this.commands, this.egress, this.logger, d.organizationId, d.environmentId);
    }
}

/** The scope's live claims get its full allowlist without a new claim (an org-list change reaches every environment). */
async function pushEgress(commands: CommandStore, egress: EgressPolicyPusher | undefined, logger: Logger, organizationId: string, environmentId: string) {
    const allow = await commands.approvedHosts(organizationId, environmentId);
    await egress?.push(organizationId, environmentId, allow).catch((e) => logger.warn({ msg: 'egress_policy.push_failed', error: (e as Error)?.message }));
}

/** An approval revoked (G3): its live claims get the list without the host, which cuts their connections to it. */
export class EgressRevokedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.EgressRevoked;
    private readonly logger = new Logger('EgressRevoked');
    constructor(
        private readonly commands: CommandStore,
        private readonly egress?: EgressPolicyPusher,
    ) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeEgressRevokedSchema.safeParse(body);
        if (!p.success) return invalid('invalid egress revocation', p.error.message);
        const d = p.data;
        const revoked = await this.commands.revokeEgressApproval({ environmentId: d.environmentId, host: d.host, organizationId: d.organizationId, revokedBy: d.revokedBy.userId, revokedAt: d.revokedAt });
        if (!revoked) this.logger.log({ msg: 'egress_revoke.nothing_live', key: d.key });
        await this.commands.recordEgressAudit({
            key: d.key + '@' + d.revokedAt, organizationId: d.organizationId, environmentId: d.environmentId, host: d.host, action: 'revoke',
            actor: d.revokedBy.userId, source: 'settings', ...(d.reason ? { reason: d.reason } : {}), detail: { revoked }, at: d.revokedAt,
        });
        await pushEgress(this.commands, this.egress, this.logger, d.organizationId, d.environmentId);
    }
}

/** The org's outbound access settings (D2, D3): the next claims read them; the change is audited. */
export class EgressSettingsChangedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.EgressSettingsChanged;
    constructor(private readonly commands: CommandStore) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeEgressSettingsChangedSchema.safeParse(body);
        if (!p.success) return invalid('invalid egress settings', p.error.message);
        const d = p.data;
        await this.commands.recordEgressSettings({ organizationId: d.organizationId, recommendedEnabled: d.recommendedEnabled, whoMayAdd: d.whoMayAdd, updatedBy: d.changedBy.userId, updatedAt: d.changedAt });
        await this.commands.recordEgressAudit({
            key: d.key, organizationId: d.organizationId, action: 'settings', actor: d.changedBy.userId, source: 'settings',
            recommendedVersion: RECOMMENDED_EGRESS_VERSION, detail: { recommendedEnabled: d.recommendedEnabled, whoMayAdd: d.whoMayAdd }, at: d.changedAt,
        });
    }
}

/** pool.target to the cell of an environment (HubPoolTargetSender). */
export interface PoolTargetSender {
    send(req: { organizationId: string; environmentId: string; size: number; machineSize?: MachineSize; cellId: string }): Promise<{ status: 'accepted' } | { status: 'refused'; code: string; message: string }>;
}

/**
 * The admin changed the pool size: the cell of the environment's last setup
 * gets it (its pool lives where its bake is). With no setup on record there
 * is no cell yet, and the next setup carries the size anyway.
 */
export class EnvironmentPoolRequestedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.EnvironmentPoolRequested;
    private readonly logger = new Logger('EnvironmentPoolRequested');
    constructor(
        private readonly setups?: { get(environmentId: string): Promise<{ organizationId: string; cellId?: string; machineSize?: MachineSize } | null> },
        private readonly pool?: PoolTargetSender,
    ) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeEnvironmentPoolRequestedSchema.safeParse(body);
        if (!p.success) return invalid('invalid pool request', p.error.message);
        const { organizationId, environmentId, size } = p.data;
        const rec = await this.setups?.get(environmentId);
        // The record must be the org's: the message alone never picks a cell.
        if (!rec || rec.organizationId !== organizationId || !rec.cellId || !this.pool) {
            this.logger.log({ msg: 'pool.request.deferred', environmentId, size, why: 'no setup cell on record; the next setup carries the size' });
            return;
        }
        // The size the last setup booted and baked at: the pool there is made at it (an older cell's hub drains it instead).
        const out = await this.pool.send({ organizationId, environmentId, size, ...(rec.machineSize ? { machineSize: rec.machineSize } : {}), cellId: rec.cellId });
        if (out.status === 'accepted') this.logger.log({ msg: 'pool.request.sent', environmentId, cellId: rec.cellId, size });
        else this.logger.warn({ msg: 'pool.request.refused', environmentId, cellId: rec.cellId, size, code: out.code });
    }
}

export class StopRequestedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.StopRequested;
    constructor(
        private readonly projection: RunProjectionStore,
        private readonly commands: CommandStore,
        private readonly engine: Pick<RunEngine, 'stop'>,
    ) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeStopRequestedSchema.safeParse(body);
        if (!p.success) return invalid('invalid stop', p.error.message);
        const organizationId = orgOf(p.data);
        if (p.data.scope === 'org' && !organizationId) return invalid('invalid stop', 'org scope without organizationId');
        await this.commands.recordStop({ scope: p.data.scope, organizationId, requestedBy: p.data.requestedBy.userId, requestedAt: p.data.requestedAt });
        // engine.stop only starts each finalization: this handler never waits on a Run.
        for (const r of await this.projection.listLive(organizationId)) {
            await this.engine.stop(
                { runId: r.runId, attempt: r.attempt, organizationId: r.organizationId, correlationId: r.correlationId, headSha: r.headSha },
                'cancelled',
                'stopped by an admin',
            );
        }
    }
}

export class StopClearedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.StopCleared;
    private readonly logger = new Logger('StopCleared');
    constructor(private readonly commands: CommandStore) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeStopClearedSchema.safeParse(body);
        if (!p.success) return invalid('invalid stop clear', p.error.message);
        const organizationId = orgOf(p.data);
        if (p.data.scope === 'org' && !organizationId) return invalid('invalid stop clear', 'org scope without organizationId');
        const cleared = await this.commands.clearStop({ scope: p.data.scope, organizationId, clearedAt: p.data.clearedAt });
        this.logger.log({ msg: 'stop.cleared', scope: p.data.scope, organizationId: organizationId ?? null, rows: cleared });
    }
}

export class EnvironmentSetupRequestedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.EnvironmentSetupRequested;
    private readonly logger = new Logger('EnvironmentSetup');
    constructor(
        private readonly engine: Pick<RunEngine, 'startSetup'>,
        private readonly sealer?: SealedSecretOpener,
    ) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeEnvironmentSetupRequestedSchema.safeParse(body);
        if (!p.success) return invalid('invalid environment setup', p.error.message);
        // The workflow input DBOS stores carries the download token sealed, never plain.
        const repoToken = this.sealer ? sealedForInput(p.data.repoToken, setupTokenBinding(p.data.key), this.sealer) : p.data.repoToken;
        // Only enqueue: boot, ready check and record run as DBOS steps, off the broker channel.
        const id = await this.engine.startSetup({ ...p.data, ...(repoToken ? { repoToken } : {}) });
        if (id === false) this.logger.warn({ msg: 'environment_setup.no_service', key: p.data.key });
        else this.logger.log({ msg: 'environment_setup.enqueued', key: p.data.key, workflowId: id, blocker: p.data.blocker?.kind ?? null });
    }
}

export class CellTokenIssuedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.CellTokenIssued;
    constructor(private readonly commands: CommandStore) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeCellTokenIssuedSchema.safeParse(body);
        if (!p.success) return invalid('invalid cell token', p.error.message);
        await this.commands.recordCellToken({ tokenHash: p.data.tokenHash, organizationId: p.data.organizationId, topology: p.data.topology, expiresAt: p.data.expiresAt, issuedBy: p.data.issuedBy.userId });
    }
}

/** Revokes an unused registration token of the org; another org's, a used or an unknown one is left as it is. */
export class CellTokenRevokedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.CellTokenRevoked;
    private readonly logger = new Logger('CellTokenRevoked');
    constructor(private readonly commands: CommandStore) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeCellTokenRevokedSchema.safeParse(body);
        if (!p.success) return invalid('invalid cell token revoke', p.error.message);
        const revoked = await this.commands.revokeCellToken({ tokenHash: p.data.tokenHash, organizationId: p.data.organizationId, revokedAt: p.data.revokedAt, revokedBy: p.data.revokedBy.userId });
        this.logger.log({ msg: revoked ? 'cell_token.revoked' : 'cell_token.not_revoked', organizationId: p.data.organizationId });
    }
}

export class CellRevokeRequestedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.CellRevokeRequested;
    constructor(private readonly commands: CommandStore) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeCellRevokeRequestedSchema.safeParse(body);
        if (!p.success) return invalid('invalid cell revoke', p.error.message);
        await this.commands.revokeCell({ cellId: p.data.cellId, reason: p.data.reason, revokedBy: p.data.requestedBy.userId });
    }
}

/** An org admin promoted or retired a lesson (ADR-018): only a lesson of that org is touched. */
export class LessonUpdateRequestedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.LessonUpdateRequested;
    private readonly logger = new Logger('LessonUpdateRequested');
    constructor(private readonly lessons?: Pick<LessonStore, 'update'>) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeLessonUpdateRequestedSchema.safeParse(body);
        if (!p.success) return invalid('invalid lesson update', p.error.message);
        if (!this.lessons) return this.logger.warn({ msg: 'lesson.no_store', lessonId: p.data.lessonId });
        const found = await this.lessons.update({ lessonId: p.data.lessonId, organizationId: p.data.organizationId, action: p.data.action, by: p.data.requestedBy.userId, at: p.data.requestedAt });
        if (!found) this.logger.warn({ msg: 'lesson.not_found', lessonId: p.data.lessonId, organizationId: p.data.organizationId });
    }
}
