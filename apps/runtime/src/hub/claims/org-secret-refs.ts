import type { Pool } from 'pg';

import { type ClaimSecret, ClaimSecretSchema, MAX_CLAIM_SECRETS } from '@libs/runtime/protocol';

/**
 * The org's secrets by reference, as claim.acquire and sandbox.acquire carry
 * them (docs/runtime/sandbox.md "Secrets: OpenBao"): id, name and hosts,
 * never a value (the value lives in OpenBao; Kodus never holds it).
 */
export interface OrgSecretRefs {
    secretsOf(organizationId: string): Promise<ClaimSecret[]>;
}

/**
 * Reads the product Postgres's runtime_secrets, written only by the API
 * (/runtime/secrets). The hub's role there (RUNTIME_PRODUCT_SECRETS_READ_URL,
 * scripts/runtime/runtime-secrets-reader-grants.sql) may SELECT these four
 * columns of that table and nothing else. A row the protocol would refuse
 * (an id or host the API never writes) is left out, so one bad row never
 * blocks a claim; at most MAX_CLAIM_SECRETS, by name.
 */
export class PgOrgSecretRefs implements OrgSecretRefs {
    constructor(private readonly pool: Pool) {}

    async secretsOf(organizationId: string): Promise<ClaimSecret[]> {
        const { rows } = await this.pool.query<{ secret_id: string; name: string; hosts: unknown }>(
            `SELECT secret_id, name, hosts FROM runtime_secrets WHERE organization_id = $1 ORDER BY name LIMIT $2`,
            [organizationId, MAX_CLAIM_SECRETS],
        );
        const out: ClaimSecret[] = [];
        for (const r of rows) {
            const parsed = ClaimSecretSchema.safeParse({ id: r.secret_id, name: r.name, hosts: r.hosts });
            if (parsed.success && parsed.data.name.toLowerCase() === parsed.data.id) out.push(parsed.data);
        }
        return out;
    }
}
