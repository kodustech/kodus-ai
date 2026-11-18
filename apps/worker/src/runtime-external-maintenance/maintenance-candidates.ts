import { Injectable } from '@nestjs/common';
import { ProductExternalMaintenanceDatabase } from './maintenance-database';

export type MaintenanceCandidateKind = 'expired' | 'terminal';
export interface MaintenanceOrganizationPage {
    organizationIds: string[];
    cursor?: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function position(cursor?: string): { at: string; id: string } | undefined {
    if (!cursor) return undefined;
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor))
        throw new Error('Invalid maintenance cursor');
    try {
        const bytes = Buffer.from(cursor, 'base64url');
        if (bytes.toString('base64url') !== cursor) throw new Error();
        const item = JSON.parse(bytes.toString('utf8'));
        if (
            !item ||
            Object.keys(item).sort().join(',') !== 'at,id' ||
            !Number.isFinite(Date.parse(item.at)) ||
            !uuid.test(item.id)
        )
            throw new Error();
        return { at: new Date(item.at).toISOString(), id: item.id };
    } catch {
        throw new Error('Invalid maintenance cursor');
    }
}

/** Administrative worker discovery returns IDs only; task access stays org-scoped in libs/runtime. */
@Injectable()
export class ExternalMaintenanceCandidates {
    constructor(
        private readonly database: ProductExternalMaintenanceDatabase,
    ) {}
    async page(
        kind: MaintenanceCandidateKind,
        at: string,
        cursor: string | undefined,
        limit: number,
    ): Promise<MaintenanceOrganizationPage> {
        if (
            !['expired', 'terminal'].includes(kind) ||
            !Number.isFinite(Date.parse(at)) ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 500
        )
            throw new RangeError('Invalid maintenance candidate window');
        const after = position(cursor);
        const column = kind === 'expired' ? 'expires_at' : 'terminal_at';
        const condition =
            kind === 'expired'
                ? 'terminal_at IS NULL AND expires_at <= $1'
                : 'terminal_at < $1';
        const rows = await (
            await this.database.source()
        ).query(
            `SELECT organization_id,receipt_id,${column} AS due_at FROM runtime_external_submissions WHERE ${condition}
             AND ($2::timestamptz IS NULL OR (${column},receipt_id)>($2::timestamptz,$3::uuid)) ORDER BY ${column},receipt_id LIMIT $4`,
            [at, after?.at ?? null, after?.id ?? null, limit],
        );
        if (!rows.length) return { organizationIds: [], cursor: undefined };
        const last = rows[rows.length - 1];
        const next = Buffer.from(
            JSON.stringify({
                at: new Date(last.due_at).toISOString(),
                id: last.receipt_id,
            }),
        ).toString('base64url');
        return {
            organizationIds: [
                ...new Set<string>(
                    rows.map(
                        (r: { organization_id: string }) => r.organization_id,
                    ),
                ),
            ],
            cursor: next,
        };
    }
}
