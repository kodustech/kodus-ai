import { type FactoryProvider, Logger } from '@nestjs/common';

import type { RunProjectionStore } from '@libs/runtime/run';

import { PR_ADMISSION_STORE, type PrAdmissionStore } from '../../shared/admission/pr-admission-store';
import { COMMAND_STORE, RUNTIME_CONFIG, RUNTIME_RUN_PROJECTION_STORE, type WorkerConfig } from '../../shared/config';
import { EVIDENCE_STORE } from '../evidence/evidence.service';
import type { EvidenceStore } from '../../shared/evidence/file-evidence-store';
import type { DistributedLocks } from '../../shared/persistence/locks';
import { ORGANIZATION_PURGE_STORE, type OrganizationPurgeStore } from '../../shared/persistence/organization-purge';
import type { CellDataPurger, ClaimReleaser } from '../run/ports';
import type { CommandStore } from '../../shared/persistence/pg-command-store';
import { RunEngineService } from '../dbos/run-engine.service';
import { PREVIEW_SERVICE } from '../preview/preview.service';
import type { PullRequestSessions } from '../sandbox/pr-sessions';
import { type SealedSecretOpener, SECRET_OPENER } from '../secrets/sealed-tokens';
import { ENVIRONMENT_SETUP_STORE, type EnvironmentSetupStore } from '../setup/environment-setup.store';
import { LESSON_STORE, type LessonStore } from '../setup/lesson.store';
import {
    CellRevokeRequestedHandler,
    CellTokenIssuedHandler,
    CellTokenRevokedHandler,
    type CommandHandler,
    EgressApprovedHandler,
    type EgressPolicyPusher,
    EgressRevokedHandler,
    EgressSettingsChangedHandler,
    MachineMinutesChangedHandler,
    EnvironmentPoolRequestedHandler,
    EnvironmentSetupRequestedHandler,
    ForkApprovedHandler,
    LessonUpdateRequestedHandler,
    type PoolTargetSender,
    StopClearedHandler,
    StopRequestedHandler,
} from './command-handlers';
import { OrganizationPurgeRequestedHandler } from './organization-purge.handler';
import type { RunEngine } from './run-engine.port';
import { type PullRequestPreviews, RunCancelRequestedHandler, RunRequestedHandler } from './run-requested.handler';
import { SuiteRequestedHandler, type SuiteStarter } from './suite-requested.handler';

/** Every handler the Runtime command consumer routes to, one per event. */
export const RUNTIME_COMMAND_HANDLERS = Symbol('RUNTIME_COMMAND_HANDLERS');
export const EGRESS_POLICY_PUSHER = Symbol('EGRESS_POLICY_PUSHER');
/** The PR's sessions, removed when it closes (worker/sandbox/pr-sessions.ts). */
export const PR_SESSIONS = Symbol('PR_SESSIONS');
export const POOL_TARGET_SENDER = Symbol('POOL_TARGET_SENDER');
/** Ends a claim through the hub (HubClaimReleaser): the organization purge releases the claims it finds live. */
export const CLAIM_RELEASER = Symbol('CLAIM_RELEASER');
export const CELL_DATA_PURGER = Symbol('CELL_DATA_PURGER');
/** The cluster-wide PR lock (Postgres advisory locks in production). */
export const CONSUMER_LOCKS = Symbol('CONSUMER_LOCKS');

/**
 * What the command handlers need. The core five are required. The rest are
 * required by the production provider below; a unit test leaves out the ones
 * its handler does not reach, and that handler then refuses or skips.
 */
export interface CommandHandlerDeps {
    engine: RunEngine;
    projection: RunProjectionStore;
    commands: CommandStore;
    admissions: PrAdmissionStore;
    locks: DistributedLocks;
    egress?: EgressPolicyPusher;
    setups?: Pick<EnvironmentSetupStore, 'get'>;
    sealer?: SealedSecretOpener;
    pool?: PoolTargetSender;
    lessons?: Pick<LessonStore, 'update'>;
    /** RUNTIME_SETUP_HEALTH_PATH: the ready path when the recipe names none. */
    healthPath?: string;
    previews?: PullRequestPreviews;
    prSessions?: Pick<PullRequestSessions, 'forget'>;
    /** The organization purge: without its store and releaser that command is not handled (the consumer dead-letters it). */
    organizationPurge?: { store: OrganizationPurgeStore; releaser: ClaimReleaser; evidence: Pick<EvidenceStore, 'deletePrefix'> | null; cells?: CellDataPurger | null };
    /** The suite engine: without it `runtime.suite.requested` is not handled (the consumer dead-letters it). */
    suites?: SuiteStarter;
    warn?: (msg: string, meta: Record<string, unknown>) => void;
}

export function runtimeCommandHandlers(deps: CommandHandlerDeps): CommandHandler[] {
    const { engine, projection, commands, admissions, locks, previews } = deps;
    return [
        new RunRequestedHandler(engine, projection, commands, locks, admissions, deps.setups, { healthPath: deps.healthPath, ...(previews ? { previews } : {}) }),
        new RunCancelRequestedHandler(engine, projection, locks, admissions, previews, deps.prSessions, deps.warn),
        new ForkApprovedHandler(projection, commands, engine),
        new EgressApprovedHandler(commands, deps.egress),
        new EgressRevokedHandler(commands, deps.egress),
        new EgressSettingsChangedHandler(commands),
        new MachineMinutesChangedHandler(commands),
        new StopRequestedHandler(projection, commands, engine),
        new StopClearedHandler(commands),
        new EnvironmentSetupRequestedHandler(engine, deps.sealer),
        new EnvironmentPoolRequestedHandler(deps.setups, deps.pool),
        new CellTokenIssuedHandler(commands),
        new CellTokenRevokedHandler(commands),
        new CellRevokeRequestedHandler(commands),
        new LessonUpdateRequestedHandler(deps.lessons),
        ...(deps.suites ? [new SuiteRequestedHandler(deps.suites)] : []),
        ...(deps.organizationPurge ? [new OrganizationPurgeRequestedHandler(engine, projection, deps.organizationPurge.store, deps.organizationPurge.releaser, deps.organizationPurge.evidence, deps.organizationPurge.cells ?? null)] : []),
    ];
}

/**
 * The production wiring: every dependency is a required injection, so a module
 * that loses one (the PR lock above all) fails at boot instead of falling back.
 */
export const runtimeCommandHandlersProvider: FactoryProvider<CommandHandler[]> = {
    provide: RUNTIME_COMMAND_HANDLERS,
    inject: [
        RunEngineService,
        RUNTIME_RUN_PROJECTION_STORE,
        COMMAND_STORE,
        PR_ADMISSION_STORE,
        CONSUMER_LOCKS,
        EGRESS_POLICY_PUSHER,
        ENVIRONMENT_SETUP_STORE,
        SECRET_OPENER,
        POOL_TARGET_SENDER,
        LESSON_STORE,
        RUNTIME_CONFIG,
        PREVIEW_SERVICE,
        PR_SESSIONS,
        ORGANIZATION_PURGE_STORE,
        CLAIM_RELEASER,
        EVIDENCE_STORE,
        CELL_DATA_PURGER,
    ],
    useFactory: (
        engine: RunEngine,
        projection: RunProjectionStore,
        commands: CommandStore,
        admissions: PrAdmissionStore,
        locks: DistributedLocks,
        egress: EgressPolicyPusher,
        setups: EnvironmentSetupStore,
        sealer: SealedSecretOpener,
        pool: PoolTargetSender,
        lessons: LessonStore,
        config: Pick<WorkerConfig, 'setup'>,
        previews: PullRequestPreviews,
        prSessions: PullRequestSessions,
        purgeStore: OrganizationPurgeStore,
        releaser: ClaimReleaser,
        evidence: EvidenceStore | null,
        cells: CellDataPurger,
    ) => {
        const logger = new Logger('RuntimeCommandConsumer');
        return runtimeCommandHandlers({
            engine,
            projection,
            commands,
            admissions,
            locks,
            egress,
            setups,
            sealer,
            pool,
            lessons,
            healthPath: config.setup.healthPath,
            previews,
            prSessions,
            organizationPurge: { store: purgeStore, releaser, evidence, cells },
            warn: (msg, meta) => logger.warn({ msg, ...meta }),
        });
    },
};
