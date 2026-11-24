import type { Pool } from 'pg';

import { BRAKE_WINDOW_SHADOWS } from '@libs/runtime/suite';

/**
 * The shadow check of selection (docs/runtime/e2e-suites.md section 6.1 "Proof (b)" and D14): `runtime_suite_shadows` holds each
 * shadow (a selected PR run that was also run in full in the background) and what it found the selection missed, and
 * `runtime_suite_selection_state` is what an environment's selection is doing because of it (how many selected runs it counted, the
 * pull requests left on the whole suite after a miss, and whether selection is off). The rules are `libs/runtime/suite/shadow.ts`.
 */

/** A shadow the worker asks the product to issue (the worker holds no repository credentials, so it cannot mint the run's download tokens). */
export interface ShadowRequest {
    /** The suite run id the shadow will have. */
    shadowRunId: string;
    organizationId: string;
    environmentId: string;
    repositoryId: string;
    /** The selected run this shadows. One shadow per source run. */
    sourceRunId: string;
    prNumber: number;
    prSha: string;
    mergeBase: string;
    mainSha: string;
    /** The specs the selected run ran: what the full run's failures are compared with. */
    selected: string[];
    /** What the PR changed: kept with a miss so the person sees what the selection did not connect to the spec. */
    changedFiles: string[];
    /** The spec files the PR removed: the full run must not list them from main. */
    removedFiles: string[];
}

export interface StoredShadow extends ShadowRequest {
    state: 'queued' | 'started' | 'done';
    /** The specs the selection skipped that the full run found a regression in (a `selection_miss` each). */
    misses: string[];
    /** False: the shadow did not finish (no host, a timeout): no evidence either way, and it does not count in the window. */
    conclusive?: boolean;
    finishedAt?: Date;
}

const toShadow = (x: Record<string, any>): StoredShadow => ({
    shadowRunId: x.shadow_run_id,
    organizationId: x.organization_id,
    environmentId: x.environment_id,
    repositoryId: x.repository_id,
    sourceRunId: x.source_run_id,
    prNumber: x.pr_number,
    prSha: x.pr_sha,
    mergeBase: x.merge_base,
    mainSha: x.main_sha,
    selected: x.selected,
    changedFiles: x.changed_files,
    removedFiles: x.removed_files,
    state: x.state,
    misses: x.selection_misses,
    ...(x.conclusive !== null ? { conclusive: x.conclusive } : {}),
    ...(x.finished_at ? { finishedAt: x.finished_at } : {}),
});

export class PgSuiteShadows {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    /** One shadow per source run: a second request for the same run changes nothing. */
    async request(r: ShadowRequest): Promise<{ created: boolean }> {
        const out = await this.pool.query(
            `INSERT INTO runtime.runtime_suite_shadows (shadow_run_id, organization_id, environment_id, repository_id, source_run_id, pr_number, pr_sha, merge_base, main_sha, selected, changed_files, removed_files)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb) ON CONFLICT DO NOTHING`,
            [r.shadowRunId, r.organizationId, r.environmentId, r.repositoryId, r.sourceRunId, r.prNumber, r.prSha, r.mergeBase, r.mainSha, JSON.stringify(r.selected), JSON.stringify(r.changedFiles), JSON.stringify(r.removedFiles)],
        );
        return { created: (out.rowCount ?? 0) > 0 };
    }

    async get(organizationId: string, shadowRunId: string): Promise<StoredShadow | null> {
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_suite_shadows WHERE organization_id = $1 AND shadow_run_id = $2`, [organizationId, shadowRunId]);
        return r.rows[0] ? toShadow(r.rows[0]) : null;
    }

    /** The queued shadows, oldest first: what the product turns into `RuntimeSuiteRequested` of mode `shadow`. */
    async pending(limit: number): Promise<StoredShadow[]> {
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_suite_shadows WHERE state = 'queued' ORDER BY requested_at, shadow_run_id LIMIT $1`, [limit]);
        return r.rows.map(toShadow);
    }

    /** The shadow's workflow holds it: the product does not issue it again. */
    async markStarted(organizationId: string, shadowRunId: string): Promise<void> {
        await this.pool.query(`UPDATE runtime.runtime_suite_shadows SET state = 'started', started_at = now(), updated_at = now() WHERE organization_id = $1 AND shadow_run_id = $2 AND state = 'queued'`, [organizationId, shadowRunId]);
    }

    /** Stores what the full run found. Only the first completion counts: `first` says whether this call was it (a replay must not apply the brake twice). */
    async complete(organizationId: string, shadowRunId: string, result: { misses: readonly string[]; conclusive: boolean }, at: Date = new Date()): Promise<{ first: boolean }> {
        const r = await this.pool.query(
            `UPDATE runtime.runtime_suite_shadows SET state = 'done', selection_misses = $3::jsonb, conclusive = $4, finished_at = $5, updated_at = now()
              WHERE organization_id = $1 AND shadow_run_id = $2 AND state <> 'done'`,
            [organizationId, shadowRunId, JSON.stringify([...result.misses]), result.conclusive, at],
        );
        return { first: (r.rowCount ?? 0) > 0 };
    }

    /** The misses (one per spec) among the environment's last `window` conclusive shadows, those finished after `since` when given. */
    async recentMisses(organizationId: string, environmentId: string, window: number = BRAKE_WINDOW_SHADOWS, since?: Date): Promise<number> {
        const r = await this.pool.query(
            `SELECT coalesce(sum(jsonb_array_length(selection_misses)), 0)::int AS n FROM (
               SELECT selection_misses FROM runtime.runtime_suite_shadows
                WHERE organization_id = $1 AND environment_id = $2 AND state = 'done' AND conclusive AND ($4::timestamptz IS NULL OR finished_at > $4)
                ORDER BY finished_at DESC, shadow_run_id LIMIT $3) w`,
            [organizationId, environmentId, window, since ?? null],
        );
        return r.rows[0].n;
    }
}

/** What an environment's selection does now. */
export interface SelectionState {
    /** Two misses in ten shadows turned selection off until a person turns it on. */
    off: boolean;
    /** Pull requests that still run the whole suite after a miss. */
    fullPrsLeft: number;
    /** When a person last turned selection on: the window of shadows starts there. */
    reenabledAt?: Date;
}

export class PgSuiteSelectionState {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    async read(organizationId: string, environmentId: string): Promise<SelectionState> {
        const r = await this.pool.query(`SELECT off, full_prs_left, reenabled_at FROM runtime.runtime_suite_selection_state WHERE organization_id = $1 AND environment_id = $2`, [organizationId, environmentId]);
        const x = r.rows[0];
        return x ? { off: x.off, fullPrsLeft: x.full_prs_left, ...(x.reenabled_at ? { reenabledAt: x.reenabled_at } : {}) } : { off: false, fullPrsLeft: 0 };
    }

    /** Counts one more selected run of the environment and answers the count (1-based), atomically. */
    async recordSelected(organizationId: string, environmentId: string): Promise<number> {
        const r = await this.pool.query(
            `INSERT INTO runtime.runtime_suite_selection_state AS s (organization_id, environment_id, selected_runs) VALUES ($1, $2, 1)
             ON CONFLICT (environment_id) DO UPDATE SET selected_runs = s.selected_runs + 1, updated_at = now() WHERE s.organization_id = EXCLUDED.organization_id
             RETURNING selected_runs`,
            [organizationId, environmentId],
        );
        return r.rows[0]?.selected_runs ?? 0;
    }

    /** A miss: the whole suite for the next `fullPrs` pull requests, and off when the window says so. Off never turns itself back on. */
    async applyMiss(organizationId: string, environmentId: string, brake: { fullPrs: number; off: boolean }): Promise<void> {
        await this.pool.query(
            `INSERT INTO runtime.runtime_suite_selection_state AS s (organization_id, environment_id, full_prs_left, off, off_at) VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN now() END)
             ON CONFLICT (environment_id) DO UPDATE SET full_prs_left = EXCLUDED.full_prs_left, off = s.off OR EXCLUDED.off,
                 off_at = CASE WHEN EXCLUDED.off AND NOT s.off THEN now() ELSE s.off_at END, updated_at = now()
              WHERE s.organization_id = EXCLUDED.organization_id`,
            [organizationId, environmentId, brake.fullPrs, brake.off],
        );
    }

    /** One pull request of the whole-suite window is under way: never below zero. */
    async consumeFullPr(organizationId: string, environmentId: string): Promise<void> {
        await this.pool.query(`UPDATE runtime.runtime_suite_selection_state SET full_prs_left = greatest(full_prs_left - 1, 0), updated_at = now() WHERE organization_id = $1 AND environment_id = $2`, [organizationId, environmentId]);
    }

    /** A person turns selection on again: off and the whole-suite window clear, and the shadows counted start afresh. Answers the time the window starts at. */
    async reenable(organizationId: string, environmentId: string, at: Date = new Date()): Promise<Date | undefined> {
        const r = await this.pool.query(
            `UPDATE runtime.runtime_suite_selection_state SET off = false, off_at = NULL, full_prs_left = 0, reenabled_at = $3, updated_at = now() WHERE organization_id = $1 AND environment_id = $2 RETURNING reenabled_at`,
            [organizationId, environmentId, at],
        );
        return r.rows[0]?.reenabled_at ?? undefined;
    }
}
