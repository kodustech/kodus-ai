import { ConfigService } from '@nestjs/config';

/** Shared result shape for the report-sending use-cases. */
export interface SendReportResult {
    organizationId: string;
    skipped?: 'no-activity' | 'no-recipients' | 'org-not-found';
    sent: number;
    failed: number;
    failures: Array<{ email: string; reason?: string }>;
}

export interface CockpitLinkOptions {
    /** Cockpit tab, e.g. 'kodus-review'. */
    tab?: string;
    /** Window start (YYYY-MM-DD) — lands the cockpit on the report's period. */
    start?: string;
    /** Window end (YYYY-MM-DD). */
    end?: string;
    /** Repository full name to pre-select (e.g. 'org/repo'). */
    repository?: string;
    /** Rules-health filter: 'noisy' | 'ignored' | 'healthy' | 'stale' | 'all'. */
    rulesHealth?: string;
}

/**
 * Cockpit deep link. The cockpit reads its state from query params
 * (`tab`/`start`/`end`/`repository`/`rulesHealth`), so a report CTA can land
 * the reader directly on the period — and repo — the email is about, instead
 * of a generic dashboard.
 */
export function buildCockpitLink(
    configService: ConfigService,
    opts: CockpitLinkOptions = {},
): string {
    const baseRaw = configService.get<string>('API_USER_INVITE_BASE_URL') ?? '';
    const base = (baseRaw || 'https://app.kodus.io').replace(/\/$/, '');

    const params = new URLSearchParams();
    if (opts.tab) params.set('tab', opts.tab);
    if (opts.start) params.set('start', opts.start);
    if (opts.end) params.set('end', opts.end);
    if (opts.repository) params.set('repository', opts.repository);
    if (opts.rulesHealth) params.set('rulesHealth', opts.rulesHealth);

    const qs = params.toString();
    return qs ? `${base}/cockpit?${qs}` : `${base}/cockpit`;
}
