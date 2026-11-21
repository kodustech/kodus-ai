// The product-side half of purging one organization's Runtime data (docs/runtime/architecture.md "Data lifecycle"):
// the product Postgres rows the Runtime keeps for an org, and the ids of its OpenBao secrets. The Runtime Postgres
// and the evidence are the worker's, reached by the command the use case sends.

export const RUNTIME_ORGANIZATION_PURGE_STORE = Symbol.for('RuntimeApi.OrganizationPurgeStore');

export interface RuntimeOrganizationPurgeStore {
    /** The ids of the org's secrets (`runtime_secrets`): the OpenBao paths to delete. */
    secretIds(organizationId: string): Promise<string[]>;
    /**
     * Removes every product row of the org that the Runtime keeps (environments, settings, run targets, PR checks,
     * publications, feedback, kept checks, secrets metadata and its audit, LLM budget counters, and the rest), in
     * batches. `keepSecretIds` are secrets whose OpenBao value could not be deleted: their metadata stays, with the
     * audit, so the purge can be run again. Rows removed per table (only the tables that had any).
     */
    purgeOrganization(organizationId: string, opts?: { keepSecretIds?: string[] }): Promise<Record<string, number>>;
}
