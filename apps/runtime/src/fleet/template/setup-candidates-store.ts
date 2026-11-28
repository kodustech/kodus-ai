import type { Pool } from 'pg';

import type { EnvironmentSetupRecord } from '@libs/runtime/run';
import { PgEnvironmentSetupReads } from '@libs/runtime/run/adapters/pg-environment-setup.store';

// The setups the template rebuild pass looks at (docs/runtime/host-providers.md §8.2): the latest setup of each
// environment, read from the worker's table (runtime.runtime_environment_setups) with the existing read adapter.

export interface SetupCandidatesReader {
    /** Active setups updated after `since`, not a template build's own, of these orgs (null: any org), newest first. */
    activeSince(since: Date, organizationIds: string[] | null, limit: number): Promise<EnvironmentSetupRecord[]>;
}

export class PgSetupCandidates implements SetupCandidatesReader {
    private readonly reads: PgEnvironmentSetupReads;
    constructor(private readonly db: Pick<Pool, 'query'>) {
        this.reads = new PgEnvironmentSetupReads(db);
    }

    async activeSince(since: Date, organizationIds: string[] | null, limit: number) {
        const ids = (
            await this.db.query(
                `SELECT environment_id FROM runtime.runtime_environment_setups
                  WHERE state = 'active' AND updated_at > $1 AND setup_key NOT LIKE 'template:%' AND ($2::text[] IS NULL OR organization_id = ANY($2::text[]))
                  ORDER BY updated_at DESC LIMIT $3`,
                [since, organizationIds, limit],
            )
        ).rows.map((r: { environment_id: string }) => r.environment_id);
        const out: EnvironmentSetupRecord[] = [];
        for (const id of ids) {
            const rec = await this.reads.get(id);
            if (rec) out.push(rec);
        }
        return out;
    }
}
