import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import type { RuntimeLlmSpendRow } from '../../domain/llm-spend';
import {
    type Clock,
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_LLM_SPEND_READER,
    RUNTIME_USAGE_REPORT_READER,
    type RuntimeApiConfig,
    type RuntimeLlmSpendReader,
    type RuntimeUsageReportReader,
} from '../../domain/ports';
import type { RunClaimUsage } from '../../domain/run-cost';
import {
    buildUsageReport,
    currentUsageMonth,
    type RuntimeUsageReport,
    USAGE_REPORT_MAX_CLAIMS,
    USAGE_REPORT_MAX_RUNS,
    type UsageReportFilters,
    usageMonthOf,
    usageReportCsv,
    type UsageSandboxOperations,
} from '../../domain/usage-report';
import { RUNTIME_PREVIEW_AUDIT_READER, type RuntimePreviewAuditReader } from '../../domain/previews';
import { RuntimeRunCostService } from '../run-cost.service';
import { orgOf, validId } from './environment-view';

export interface RuntimeUsageReportQuery {
    /** `YYYY-MM` (UTC); the current month when absent. */
    month?: unknown;
    repositoryId?: unknown;
    environmentId?: unknown;
}

const optionalId = (v: unknown, name: string): string | undefined => {
    if (v === undefined || v === '') return undefined;
    if (!validId(v)) throw new BadRequestException(`${name} must be an id`);
    return v;
};

/**
 * GET /runtime/settings/usage (and its CSV) — owner only: what the org's
 * Runs, setups and sandbox sessions used in one UTC month, by repository and
 * environment when asked (docs/runtime/usage-report.md). 503 without the
 * Runtime's read-only URL; the LLM part reads "not measured" when the usage
 * spans cannot be read here.
 */
@Injectable()
export class GetRuntimeUsageReportUseCase {
    private readonly logger = createLogger(GetRuntimeUsageReportUseCase.name);

    constructor(
        @Inject(RUNTIME_USAGE_REPORT_READER)
        private readonly reader: RuntimeUsageReportReader,
        private readonly costs: RuntimeRunCostService,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: Pick<RuntimeApiConfig, 'cellPrices' | 'machineUnitPrices'>,
        @Inject(RUNTIME_CLOCK)
        private readonly clock: Clock,
        @Optional()
        @Inject(RUNTIME_LLM_SPEND_READER)
        private readonly spend?: RuntimeLlmSpendReader,
        @Optional()
        @Inject(RUNTIME_PREVIEW_AUDIT_READER)
        private readonly previewAudit?: Pick<RuntimePreviewAuditReader, 'sessionsOfMonth'>,
    ) {}

    async execute(input: { user: Partial<IUser>; query?: RuntimeUsageReportQuery }): Promise<RuntimeUsageReport> {
        const organizationId = orgOf(input.user);
        const q = input.query ?? {};
        const now = this.clock();
        const month = q.month === undefined || q.month === '' ? currentUsageMonth(now) : typeof q.month === 'string' ? usageMonthOf(q.month) : null;
        if (!month) throw new BadRequestException('month must be YYYY-MM');
        const filters: UsageReportFilters = {
            ...(optionalId(q.repositoryId, 'repositoryId') ? { repositoryId: q.repositoryId as string } : {}),
            ...(optionalId(q.environmentId, 'environmentId') ? { environmentId: q.environmentId as string } : {}),
        };

        const [{ runs, total }, { claims, truncated }, spend, sandboxOperations, previewSessions] = await Promise.all([
            this.reader.runsOfMonth(organizationId, month, filters, USAGE_REPORT_MAX_RUNS),
            this.reader.claimsOfMonth(organizationId, month, filters, USAGE_REPORT_MAX_CLAIMS),
            this.spendOfMonth(organizationId, month),
            this.sandboxOperationsOfMonth(organizationId, month),
            // Unreadable (a reader without the grant on runtime_preview_audit): the count is null, the report still answers.
            this.previewAudit?.sessionsOfMonth(organizationId, month).catch(() => undefined),
        ]);
        const claimsOfRun = new Map<string, RunClaimUsage[]>();
        for (const c of claims) if (c.runId && c.consumer === 'runtime') claimsOfRun.set(c.runId, [...(claimsOfRun.get(c.runId) ?? []), c]);
        const costs = await this.costs.forRuns(
            runs.map((r) => ({
                runId: r.runId,
                organizationId,
                requestedAt: r.requestedAt,
                ...(r.bootingAt ? { bootingAt: r.bootingAt } : {}),
                ...(r.startedAt ? { startedAt: r.startedAt } : {}),
                ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
                ...(r.cellOwner ? { cellOwner: r.cellOwner } : {}),
            })),
            { claims: claimsOfRun },
        );
        const cellPrices = this.config.cellPrices ?? {};
        return buildUsageReport({
            organizationId,
            month,
            filters,
            runs,
            runsTotal: total,
            claims,
            claimsTruncated: truncated,
            spend,
            ...(sandboxOperations ? { sandboxOperations } : {}),
            ...(previewSessions !== undefined ? { previewSessions } : {}),
            costs,
            cellPriceOf: (cellId) => cellPrices[cellId] ?? null,
            ...(this.config.machineUnitPrices ? { unitPrices: this.config.machineUnitPrices } : {}),
            now,
        });
    }

    /** The report's Runs as CSV, and the file name it downloads as. */
    async csv(input: { user: Partial<IUser>; query?: RuntimeUsageReportQuery }): Promise<{ filename: string; body: string }> {
        const report = await this.execute(input);
        return { filename: `kody-runtime-usage-${report.month}.csv`, body: usageReportCsv(report) };
    }

    /** The org's sandbox operations of the month; unreadable (a reader without the audit grant): undefined, the count is null. */
    private async sandboxOperationsOfMonth(organizationId: string, month: { start: Date; end: Date }): Promise<UsageSandboxOperations | undefined> {
        try {
            return await this.reader.sandboxOperationsOfMonth(organizationId, month);
        } catch (e) {
            this.logger.warn({
                message: 'Runtime usage report: the sandbox audit could not be read; sandbox operations are not counted',
                context: GetRuntimeUsageReportUseCase.name,
                error: e instanceof Error ? e : undefined,
                metadata: { organizationId },
            });
            return undefined;
        }
    }

    /** The org's Runtime spans of the month; unreadable here: undefined, the LLM part is "not measured". */
    private async spendOfMonth(organizationId: string, month: { start: Date; end: Date }): Promise<RuntimeLlmSpendRow[] | undefined> {
        if (!this.spend) return undefined;
        try {
            return await this.spend.spendOf({ organizationId, start: month.start, end: month.end });
        } catch (e) {
            this.logger.warn({
                message: 'Runtime usage report: the usage spans could not be read; the LLM part is not measured',
                context: GetRuntimeUsageReportUseCase.name,
                error: e instanceof Error ? e : undefined,
                metadata: { organizationId },
            });
            return undefined;
        }
    }
}
