import { PreviewDomainSchema, PREVIEW_REASONS, previewSettingsOf } from '@libs/runtime/contracts/preview';
import type { Sql } from '@libs/runtime/api/infrastructure/typeorm-sql';

import type { PreviewOffer } from '../domain/render-runtime-comment';
import type { PreviewOfferReader } from '../domain/runtime-publish.ports';

/**
 * The preview a Run's comment offers (docs/runtime/preview-urls.md §8.1),
 * from the product Postgres: the org's runtime_settings.preview, with the
 * defaults for a row without it. Nothing where this process has no
 * RUNTIME_PREVIEW_DOMAIN (the same "off until set" rule as the worker), nor
 * for an org that turned previews off. A fork's PR side is offered only when
 * the org allows fork previews; the comment says so otherwise.
 */
export class ProductPreviewOfferReader implements PreviewOfferReader {
    private readonly on: boolean;

    constructor(
        private readonly sql: Sql,
        previewDomain: string | undefined,
    ) {
        this.on = PreviewDomainSchema.safeParse(previewDomain?.trim().toLowerCase()).success;
    }

    async offerFor(target: { organizationId: string; fork?: boolean }): Promise<PreviewOffer | null> {
        if (!this.on) return null;
        const r = await this.sql.query(`SELECT preview FROM runtime_settings WHERE organization_id = $1 LIMIT 1`, [target.organizationId]);
        const settings = previewSettingsOf(r.rows[0]?.preview);
        if (!settings.enabled) return null;
        return { idleMinutes: settings.idleMinutes, ...(target.fork === true && settings.forks === 'off' ? { prOff: PREVIEW_REASONS.forkOff } : {}) };
    }
}
