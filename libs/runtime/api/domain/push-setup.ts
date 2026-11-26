import type { EnvironmentSetupRecord } from '@libs/runtime/run/environment-setup';

// A push to an environment's default branch sets the environment up again (docs/runtime/fork-from-checkpoint.md R6):
// the template is rebuilt and a main baseline suite run is requested for that commit. These are its rules; the use
// case is application/default-branch-push-setup.service.ts.

export const RUNTIME_PUSH_SETUP_LEDGER = Symbol.for('RuntimeApi.PushSetupLedger');
export const RUNTIME_PUSH_SETUP_CONFIG = Symbol.for('RuntimeApi.PushSetupConfig');

/** Setups a default-branch push may start per environment per UTC day, when RUNTIME_PUSH_SETUP_DAILY_LIMIT does not say. */
export const DEFAULT_PUSH_SETUP_DAILY_LIMIT = 12;

/** A setup no worker has touched for this long no longer holds a push back (a lost command must not block pushes for good). */
export const PUSH_SETUP_STALE_MS = 2 * 60 * 60 * 1000;

export interface PushSetupConfig {
    /** Setups per environment per UTC day; 0 turns the push trigger off. A manual "Set up again" never counts. */
    dailyLimit: number;
}

export interface PushSetupKey {
    organizationId: string;
    environmentId: string;
}

export type PushSetupClaim =
    | { status: 'none' }
    /** The pending commit is now this setup's, and today's count went up by one. */
    | { status: 'claimed'; sha: string; spentToday: number }
    /** Today's allowance was already used: the pending commit is dropped, nothing is counted. */
    | { status: 'budget_spent'; sha: string; spentToday: number };

/**
 * `runtime_push_setups` (product Postgres): per environment, the newest commit pushed that no setup has taken yet
 * (coalescing: a later push replaces an earlier one) and how many setups the pushes started today.
 */
export interface PushSetupLedger {
    /** The newest pushed commit of the environment; replaces an older pending one. */
    markPending(key: PushSetupKey, sha: string, at: Date): Promise<void>;
    /** Takes the pending commit for a setup and spends one of today's, in one atomic step. */
    claim(key: PushSetupKey, at: Date, dailyLimit: number): Promise<PushSetupClaim>;
    /** Gives the commit back (the setup request failed); a newer pending commit is never overwritten. */
    restorePending(key: PushSetupKey, sha: string, at: Date): Promise<void>;
    /** Drops the pending commit, only if it is still `sha`. */
    clearPending(key: PushSetupKey, sha: string): Promise<void>;
    /** Environments with a pending commit, the oldest first. */
    listPending(limit: number): Promise<Array<PushSetupKey & { sha: string }>>;
}

/** What the product knows of the environment's setup: its own state, and the worker's latest record. */
export interface SetupInFlightFacts {
    productState: 'setup_requested' | 'active';
    setupRequestedAt?: string;
    record: Pick<EnvironmentSetupRecord, 'state' | 'requestedAt' | 'updatedAt' | 'sha' | 'workspace'> | null;
}

/**
 * Whether a setup of the environment is queued or running. Queued: the product asked after the worker's latest
 * record began, and the worker has not written one since. Running: the record says `setting_up`. Either goes stale
 * after PUSH_SETUP_STALE_MS without a sign of life.
 */
export function isSetupInFlight(f: SetupInFlightFacts, now: Date): boolean {
    const fresh = (iso: string | undefined) => !!iso && now.getTime() - Date.parse(iso) < PUSH_SETUP_STALE_MS;
    if (f.record?.state === 'setting_up' && fresh(f.record.updatedAt)) return true;
    if (f.productState !== 'setup_requested' || !f.setupRequestedAt) return false;
    const answered = f.record && Date.parse(f.record.requestedAt) >= Date.parse(f.setupRequestedAt);
    return !answered && fresh(f.setupRequestedAt);
}

/** The commit the setup record booted this repository at: the primary's `sha`, a member's from the workspace. */
export function setupShaOf(record: SetupInFlightFacts['record'], repositoryId: string, isPrimary: boolean): string | undefined {
    if (!record) return undefined;
    if (isPrimary) return record.sha;
    return record.workspace?.find((w) => w.repositoryId === repositoryId)?.sha;
}
