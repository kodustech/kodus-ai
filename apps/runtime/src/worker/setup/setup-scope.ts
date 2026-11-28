import type { RuntimeMetrics } from '@libs/runtime/telemetry';
import { nulJoinedHex, uuidV4ShapeFrom } from '@libs/runtime/contracts/derive-id';

import { Logger } from '@nestjs/common';

import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import type { AuthoredFile } from '@libs/runtime/contracts/authored-files';
import type { EnvironmentRuntime } from '@libs/runtime/environment';
import { type ClaimWorkspace, type EnvironmentSetupRecord, lastActiveOf, setupClaimWorkspace } from '@libs/runtime/run';

import type { RecipeAuthorClient } from '../agent/http-recipe-author';
import type { SetupRepoTokensClient } from '../agent/http-setup-repo-tokens';
import type { PhysicalAdmissionTicket } from '../../shared/admission/admission-contract';
import type { EnvironmentSetupStore } from './environment-setup.store';
import type { LearnLoopOptions, SetupLearnLoop } from './learn-loop';
import type { LessonStore } from './lesson.store';
import { SetupJournal } from './setup-journal';

// What every phase of one setup shares (the SetupScope), the way a Run's
// phases share a RunScope (run-orchestrator.ts): the command, the worker's
// deps, the record being written and its journal, and what the setup has
// settled so far. Only step outputs fill it, so a replay rebuilds the same
// scope.

export type SetupExpose = NonNullable<EnvironmentSetupRecord['expose']>;

/** A checkpointed step (DBOS.runStep in the workflow, a plain call in tests). */
export type SetupStepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export interface SetupEnvFactory {
    /** The repo token stays sealed (bound to the setup key); the environment opens it inside the boot step. */
    envForSetup(input: { correlationId: string; organizationId: string; setupKey: string; fullName: string; sealedRepoToken: string; imageId: string; expose: SetupExpose; admissionTicket?: PhysicalAdmissionTicket; workspace?: ClaimWorkspace }): EnvironmentRuntime;
}

export interface SetupExecutionOptions {
    admissionTicket?: PhysicalAdmissionTicket;
    noCapacityWait?: boolean;
    admissionBlocker?: { kind: 'resources' | 'platform'; signature: string; message: string };
}

export interface SetupOptions {
    /** The worker's §11 metrics (setup outcomes, blockers); absent in unit tests that do not read them. */
    metrics?: RuntimeMetrics;
    /**
     * Explicit dev override (RUNTIME_SETUP_DEV_SHA): boot this commit instead
     * of the one the product resolved, even past a ref or token blocker. Never
     * a fallback: without it a request with no commit is a blocker.
     */
    devSha?: string;
    /** Explicit dev override of the expose list (RUNTIME_SETUP_EXPOSE, JSON); wins over the recipe. */
    devExpose?: SetupExpose;
    /** Ready path when the recipe has no services.compose.health (RUNTIME_SETUP_HEALTH_PATH). */
    healthPath?: string;
    now?: () => Date;
    /** The wait between two tries of the ready check, and between two asks for room on a cell (tests make it instant). */
    sleep?: (ms: number) => Promise<void>;
    /** How long a boot waits for room on a cell (ADR-070); SETUP_CAPACITY_WAIT_MS when absent. */
    capacityWaitMs?: number;
    /**
     * Where a setup that proves a fix records the lesson (ADR-018), and the
     * environment's approved hosts it reads to tell an allowed host made the
     * difference. Without it nothing is learned.
     */
    lessons?: { store: LessonStore; approvedHosts(organizationId: string, environmentId: string): Promise<string[]> };
    /**
     * Kody's learn loop on a blocked default-branch setup (learn-loop.ts): the
     * product's LLM gateway and the lessons it reads. Without it, or without a
     * setup token in the command, the loop is off and the catalog's card stays.
     */
    learn?: LearnLoopOptions;
    /**
     * Kody writes the recipe when the default branch has none and Kodus could
     * not infer one (docs RECIPE-AGENT-TEST-PLAN, "Ligar ao produto"): the
     * product's endpoint, called with the setup token. Without it, or without
     * a setup token in the command, the setup goes on as before.
     */
    author?: RecipeAuthorClient;
    /**
     * How many times one setup sends a failed boot of Kody's recipe back to
     * Kody and boots the recipe it rewrites (RUNTIME_SETUP_AUTHOR_REPAIRS,
     * read and bounded once by loadSetupConfig): SETUP_AUTHOR_REPAIRS_DEFAULT
     * when absent, 0 turns it off.
     */
    authorRepairs?: number;
    /**
     * Fresh download tokens for the boot of each repair: the cell revokes a
     * repository token right after its first download, so the setup
     * command's tokens serve its first boot only. Without it a repair stops
     * before Kody is asked, saying why.
     */
    repoTokens?: SetupRepoTokensClient;
}

/** The worker's side of every setup: what EnvironmentSetupService was built with. */
export interface SetupDeps {
    envs: SetupEnvFactory;
    store: EnvironmentSetupStore;
    opts: SetupOptions;
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
    /** A hub restarting mid-setup holds no claim for a while: the setup's lease checks ask again (claim-liveness.ts). */
    leaseRetry: { unavailableRetryMs: readonly number[]; sleep: (ms: number) => Promise<void> };
    /** How many repairs of Kody's recipe one setup makes (SetupOptions.authorRepairs). */
    repairs: number;
    loop?: SetupLearnLoop;
}

/** One setup before its commit is known: the command, the record and its journal. */
export interface SetupScope {
    cmd: RuntimeEnvironmentSetupRequested;
    deps: SetupDeps;
    step: SetupStepRunner;
    cancellationSignal?: () => AbortSignal | undefined;
    execution: SetupExecutionOptions;
    /** The environment's last setup, as `load` read it. */
    previous: EnvironmentSetupRecord | null;
    rec: EnvironmentSetupRecord;
    journal: SetupJournal;
}

/** What the cell boots with: the recipe the product read, or the one Kody wrote. */
export interface BootRecipe {
    path: string;
    content: string | null;
    files?: AuthoredFile[];
}

/** The download tokens the next boot uses: the command's, then each repair's fresh ones. */
export interface BootTokens {
    sealedRepoToken: string;
    workspaceRefs: RuntimeEnvironmentSetupRequested['workspace'];
    /** When they were issued: the command's a moment after the request, a fresh answer just after the journaled time it is kept with. */
    issuedAt: string;
    /** The setup's boots download with tokens the cell revokes after one use. */
    needsFresh: boolean;
}

/** A setup whose commit is resolved: what its recipe phase, its boots and its repairs share. */
export interface SetupRun extends SetupScope {
    sha: string;
    /** What the current recipe exposes (or the dev override); each boot exposes what its own recipe says. */
    expose: SetupExpose;
    bootRecipe?: BootRecipe;
    tokens: BootTokens;
}

export const setupLogger = new Logger('EnvironmentSetup');

export const SETUP_IMAGE = 'setup';

/** The setup's trace id, derived from its command key (stable across a resumed workflow). */
export const setupCorrelationId = (key: string) => uuidV4ShapeFrom(nulJoinedHex(['kody-runtime/setup', key]));

/**
 * The cell a new setup carries from the last one of the same org: where its last
 * boot built (its build state and cache), else the active setup's cell (a record
 * older than buildCellId). Never `cellId`: the new setup has no active cell yet.
 */
export function carriedBuildCell(previous: EnvironmentSetupRecord | null, organizationId: string): { buildCellId?: string } {
    if (!previous || previous.organizationId !== organizationId) return {};
    const cell = previous.buildCellId ?? previous.cellId;
    return cell ? { buildCellId: cell } : {};
}

/** The new record of a setup the command asks for, with what it carries from the environment's last one, and its journal. */
export function openSetup(
    deps: SetupDeps,
    cmd: RuntimeEnvironmentSetupRequested,
    previous: EnvironmentSetupRecord | null,
    step: SetupStepRunner,
    cancellationSignal: (() => AbortSignal | undefined) | undefined,
    execution: SetupExecutionOptions,
): SetupScope {
    const rec: EnvironmentSetupRecord = {
        environmentId: cmd.environmentId,
        organizationId: cmd.organizationId,
        repositoryId: cmd.repositoryId,
        key: cmd.key,
        state: 'setting_up',
        steps: [],
        blockers: [],
        requestedAt: cmd.requestedAt,
        updatedAt: cmd.requestedAt,
        // The size every boot of this setup asks, and every Run on it after.
        ...(cmd.machineSize ? { machineSize: cmd.machineSize } : {}),
        // What the last good setup took, for the one running to show what to expect.
        ...(previous?.lastActive ? { lastActive: previous.lastActive } : {}),
        // The cell that holds the environment's build state and bake: this record replaces the last one
        // before the boot, and the boot's cell preference (poolCellOf) reads it. The boot overwrites it.
        ...carriedBuildCell(previous, cmd.organizationId),
        // The environment's recent boots (Environment Health's setup numbers).
        ...(previous?.boots?.length ? { boots: previous.boots } : {}),
        // The last re-authoring for a new version of the author's instructions: never asked twice for one version.
        ...(previous?.reauthor ? { reauthor: previous.reauthor } : {}),
    };
    const journal = new SetupJournal(rec, step, { now: deps.now, store: deps.store, metrics: deps.opts.metrics });
    return { cmd, deps, step, ...(cancellationSignal ? { cancellationSignal } : {}), execution, previous, rec, journal };
}

/** The setup at its commit: the record names it (and every repository's), and the boots start from the command's tokens. */
export function atCommit(setup: SetupScope, sha: string): SetupRun {
    const { cmd, rec } = setup;
    rec.sha = sha;
    if (cmd.workspace) {
        rec.workspace = cmd.workspace.map((r) => ({ repositoryId: r.repositoryId, alias: r.alias, role: r.role, sha: r.role === 'primary' ? sha : r.sha, branch: r.branch }));
    }
    const tokens: BootTokens = {
        sealedRepoToken: cmd.repoToken ?? '',
        workspaceRefs: cmd.workspace,
        issuedAt: cmd.requestedAt,
        needsFresh: !!cmd.repoToken || !!cmd.workspace?.some((r) => r.sealedRepoToken),
    };
    return Object.assign(setup, { sha, expose: [] as SetupExpose, tokens });
}

/** One per boot: each boot exposes what its own recipe says, and downloads with its own tokens. */
export function envFor(run: SetupRun, repoToken = run.tokens.sealedRepoToken, refs = run.tokens.workspaceRefs): EnvironmentRuntime {
    const { cmd, execution } = run;
    const workspace = setupClaimWorkspace({ workspace: refs, ...(repoToken ? { repoToken } : {}) });
    return run.deps.envs.envForSetup({
        ...(execution.admissionTicket ? { admissionTicket: execution.admissionTicket } : {}),
        correlationId: setupCorrelationId(cmd.key),
        organizationId: cmd.organizationId,
        setupKey: cmd.key,
        fullName: cmd.repositoryFullName ?? cmd.repositoryName,
        sealedRepoToken: repoToken,
        imageId: SETUP_IMAGE,
        expose: run.expose,
        // Every repository of a multi-repository environment, each with its own sealed token, fetched with each boot.
        ...(workspace ? { workspace } : {}),
    });
}

/** Ends the setup: blocked when it has a blocker, else active, with what its last good boot took; the last save. */
export async function settle(setup: SetupScope): Promise<EnvironmentSetupRecord> {
    const { rec } = setup;
    rec.finishedAt ??= rec.updatedAt;
    if (rec.state === 'setting_up') rec.state = rec.blockers.length ? 'blocked' : 'active';
    const last = lastActiveOf(rec);
    if (last) rec.lastActive = last;
    await setup.journal.save(rec);
    return rec;
}
