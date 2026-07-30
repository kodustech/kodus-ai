import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ITokenUsageRepository } from '@libs/analytics/domain/token-usage/contracts/tokenUsage.repository.contract';
import {
    BaseUsageContract,
    DailyUsageByPrResultContract,
    DailyUsageResultContract,
    TierUsage,
    TokenUsageQueryContract,
    UsageByAreaResultContract,
    UsageByPrResultContract,
    UsageByReviewResultContract,
    UsageSummaryContract,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';

import { ObservabilityTelemetryModel } from './schemas/observabilityTelemetry.model';
import { PricingResolver } from '@libs/analytics/application/use-cases/usage/pricing-resolver';

type RawAggRow = {
    model: string;
    /** Bracket index: 0 = default band, k = above the k-th input threshold. */
    tier: number;
    input: number;
    output: number;
    total: number;
    outputReasoning: number;
    cacheRead: number;
    cacheWrite: number;
    date?: string;
    prNumber?: number;
    review?: string;
    startedAt?: Date;
    area?: string;
};

// Rows written before the area backfill ran have no `tu.area` — group them
// under the same bucket new un-mapped runs get.
const AREA_FALLBACK = 'other';

// Upper bound on rows returned by the per-review read (rows are per run ×
// model × tier). ~5 models/run → this covers the heaviest ~1600 runs, far
// beyond what the chart (top 24) or table (top 100) show, while bounding the
// payload for an org with a huge date window.
const REVIEW_ROWS_CAP = 8000;

@Injectable()
export class TokenUsageRepository implements ITokenUsageRepository {
    constructor(
        @InjectModel(ObservabilityTelemetryModel.name)
        private readonly observabilityTelemetryModel: Model<ObservabilityTelemetryModel>,
        private readonly pricingResolver: PricingResolver,
    ) {}

    /**
     * Canonical model → input-tier threshold, straight from the cached pricing
     * catalog (Gemini Pro today). This is the SOURCE OF TRUTH for tiering — tier
     * is derived per read from it (not baked), so a catalog change (e.g. a new
     * tiered model) is reflected immediately with no re-backfill.
     *
     * Resolved catalog-side, NOT from the window: enumerating which models are
     * tiered needs no data scan, so the covered read pays a single index scan
     * instead of an extra ~4.5s distinct-models scan just to discover names.
     * Branches for models absent from the window simply never match.
     */
    private _thresholds(): Promise<Map<string, number[]>> {
        return this.pricingResolver.tieredInputThresholds();
    }

    /**
     * Aggregation expression that derives a call's BRACKET INDEX from the
     * covered `attributes.tu.model` + `attributes.tu.input` and the catalog
     * thresholds. 0 = at/below the first threshold (default rate); k = above
     * the k-th threshold (k-th tier rate). Computed as the count of the
     * model's thresholds the call's input exceeds. Reads only index fields →
     * the pipeline stays covered. Supports N thresholds per model (Doubao).
     */
    private _tierExpr(thresholds: Map<string, number[]>): any {
        // `$literal`, not a bare 0: in a `$project` (the overview `$facet`
        // path) a plain 0 is read as field EXCLUSION and crashes the mixed
        // projection. `$literal` forces the VALUE 0 (bracket 0 = default
        // band) — the safe degradation when no model is tiered.
        if (thresholds.size === 0) return { $literal: 0 };
        const branches: Array<{ case: any; then: number[] }> = [];
        for (const [model, thrs] of thresholds) {
            branches.push({
                case: { $eq: ['$attributes.tu.model', model] },
                then: thrs,
            });
        }
        return {
            $let: {
                vars: { thrs: { $switch: { branches, default: [] } } },
                in: {
                    $size: {
                        $filter: {
                            input: '$$thrs',
                            as: 't',
                            cond: {
                                $gt: ['$attributes.tu.input', '$$t'],
                            },
                        },
                    },
                },
            },
        };
    }

    /**
     * Returns one BaseUsageContract per logical bucket (per model + per
     * groupKey), folding the raw bracket rows into `byTier` (an array indexed
     * by bracket). `byTier` is kept only for models declared as tier-aware in
     * `thresholds`, sized to `thresholds + 1` buckets; flat-priced models get
     * a clean flat contract.
     */
    private _mergeTierRows<T extends BaseUsageContract>(
        rows: RawAggRow[],
        thresholds: Map<string, number[]>,
        keyOf: (r: RawAggRow) => string,
        finalize: (base: BaseUsageContract, row: RawAggRow) => T,
    ): T[] {
        const grouped = new Map<string, T>();
        for (const row of rows) {
            const key = keyOf(row);
            const existing = grouped.get(key);
            const tierBucket: TierUsage = {
                input: row.input,
                output: row.output,
                total: row.total,
                outputReasoning: row.outputReasoning,
                cacheRead: row.cacheRead,
                cacheWrite: row.cacheWrite,
            };
            if (!existing) {
                const modelThresholds = thresholds.get(row.model);
                const base: BaseUsageContract = {
                    model: row.model,
                    input: row.input,
                    output: row.output,
                    total: row.total,
                    outputReasoning: row.outputReasoning,
                    cacheRead: row.cacheRead,
                    cacheWrite: row.cacheWrite,
                    ...(modelThresholds
                        ? {
                              byTier: Array.from(
                                  { length: modelThresholds.length + 1 },
                                  () => emptyTier(),
                              ),
                          }
                        : {}),
                };
                if (base.byTier) addTier(base.byTier[row.tier], tierBucket);
                grouped.set(key, finalize(base, row));
            } else {
                existing.input += row.input;
                existing.output += row.output;
                existing.total += row.total;
                existing.outputReasoning += row.outputReasoning;
                existing.cacheRead = (existing.cacheRead ?? 0) + row.cacheRead;
                existing.cacheWrite =
                    (existing.cacheWrite ?? 0) + row.cacheWrite;
                if (existing.byTier) {
                    addTier(existing.byTier[row.tier], tierBucket);
                }
            }
        }
        return Array.from(grouped.values());
    }

    /**
     * Reads the pre-derived, indexable `attributes.tu.*` sub-doc via the
     * covering index instead of $getField over the fat dotted-key attributes.
     * The aggregation is index-covered (docsExamined=0) → ~2s vs ~90s.
     *
     * Both Token Usage views are reproduced EXACTLY via the baked flags (see
     * token-usage-tu.ts):
     *   - byok=true  → attributes.tu.isByok === true  (spans with type='byok')
     *   - byok=false → attributes.tu.sys === false     (all usage spans except
     *     the internal system-analysis run-names — the cost-simulation view)
     * `tu` exists only on spans that had LLM usage, so matching either flag also
     * implies "has token data" (the old matchHasTokenData guard).
     */
    /**
     * Shared `$match` for the covered path: org + timestamp + the view flag
     * (isByok/sys), plus optional prNumber and model filters. `prOnly` restricts
     * to spans that carry a prNumber (for the by-PR aggregations).
     */
    private _tuMatch(
        query: TokenUsageQueryContract,
        prOnly = false,
    ): Record<string, any> {
        const match: Record<string, any> = {
            'attributes.organizationId': query.organizationId,
            timestamp: { $gte: query.start, $lte: query.end },
            ...(query.byok
                ? { 'attributes.tu.isByok': true }
                : { 'attributes.tu.sys': false }),
        };
        if (query.prNumber) match['attributes.prNumber'] = query.prNumber;
        // Repository scope, pre-resolved to PR numbers by the service. An
        // empty list is a repo with no PRs → matches nothing, by design.
        else if (query.prNumbers)
            match['attributes.prNumber'] = { $in: query.prNumbers };
        else if (prOnly)
            // `{$type:'number'}` — NOT `{$exists:true,$ne:null}`: $exists in the
            // match forces a FETCH of every candidate doc (docsExamined=1.27M,
            // ~13s), while a value predicate is read from the covering index
            // (docsExamined=0, ~3s). Equivalent — prNumber is always numeric
            // when present.
            match['attributes.prNumber'] = { $type: 'number' };
        if (query.models)
            match['attributes.tu.model'] = { $in: query.models.split(',') };
        return match;
    }

    private async _tuRows(
        query: TokenUsageQueryContract,
        thresholds: Map<string, number[]>,
        groupById: Record<string, any> = {},
        projectExtras: Record<string, any> = {},
        prOnly = false,
        extraMatch: Record<string, any> = {},
        extraAcc: Record<string, any> = {},
        maxRows = 0,
    ): Promise<RawAggRow[]> {
        const pipeline: Record<string, any>[] = [
            { $match: { ...this._tuMatch(query, prOnly), ...extraMatch } },
            // Derive the tier per call from the catalog thresholds (not baked).
            { $addFields: { _tier: this._tierExpr(thresholds) } },
            {
                $group: {
                    _id: {
                        model: '$attributes.tu.model',
                        tier: '$_tier',
                        ...groupById,
                    },
                    input: { $sum: '$attributes.tu.input' },
                    output: { $sum: '$attributes.tu.output' },
                    total: { $sum: '$attributes.tu.total' },
                    outputReasoning: { $sum: '$attributes.tu.reasoning' },
                    cacheRead: { $sum: '$attributes.tu.cacheRead' },
                    cacheWrite: { $sum: '$attributes.tu.cacheWrite' },
                    ...extraAcc,
                },
            },
            {
                $project: {
                    ...projectExtras,
                    _id: 0,
                    model: '$_id.model',
                    tier: '$_id.tier',
                    input: 1,
                    output: 1,
                    total: 1,
                    outputReasoning: 1,
                    cacheRead: 1,
                    cacheWrite: 1,
                },
            },
        ];
        // Safety valve for unbounded dimensions (by-review): keep the heaviest
        // rows and cap the payload so a huge window can't ship tens of
        // thousands of rows. Sorted by total desc, so the top consumers (all
        // the frontend charts/table show) survive intact.
        if (maxRows > 0) {
            pipeline.push({ $sort: { total: -1 } }, { $limit: maxRows });
        }
        return this.observabilityTelemetryModel
            .aggregate<RawAggRow>(pipeline as any)
            .exec();
    }

    async getSummary(
        query: TokenUsageQueryContract,
    ): Promise<UsageSummaryContract> {
        const rows = await this._tuRows(query, await this._thresholds());

        // Cross-model rollup: one row total.
        const summary: UsageSummaryContract = {
            model: '',
            input: 0,
            output: 0,
            total: 0,
            outputReasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
        };
        for (const r of rows) {
            summary.input += r.input;
            summary.output += r.output;
            summary.total += r.total;
            summary.outputReasoning += r.outputReasoning;
            summary.cacheRead = (summary.cacheRead ?? 0) + r.cacheRead;
            summary.cacheWrite = (summary.cacheWrite ?? 0) + r.cacheWrite;
        }
        return summary;
    }

    /**
     * Per-model summary across the date range with tier breakdown. Powers the
     * detail table on the Token Usage page — one block per model, each with
     * its byTier counts.
     */
    async getSummaryByModel(
        query: TokenUsageQueryContract,
    ): Promise<BaseUsageContract[]> {
        const thresholds = await this._thresholds();
        const rows = await this._tuRows(query, thresholds);
        return this._mergeTierRows(
            rows,
            thresholds,
            (r) => r.model,
            (base) => base,
        );
    }

    async getDailyUsage(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageResultContract[]> {
        const thresholds = await this._thresholds();
        const rows = await this._tuRows(
            query,
            thresholds,
            {
                date: {
                    $dateToString: {
                        format: '%Y-%m-%d',
                        date: '$timestamp',
                        timezone: query.timezone || 'UTC',
                    },
                },
            },
            { date: '$_id.date' },
        );

        const merged = this._mergeTierRows<DailyUsageResultContract>(
            rows,
            thresholds,
            (r) => `${r.date}|${r.model}`,
            (base, row) => ({ ...base, date: row.date! }),
        );
        merged.sort((a, b) =>
            a.date === b.date
                ? a.model.localeCompare(b.model)
                : a.date.localeCompare(b.date),
        );
        return merged;
    }

    async getUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<UsageByPrResultContract[]> {
        const thresholds = await this._thresholds();
        const rows = await this._tuRows(
            query,
            thresholds,
            { pr: '$attributes.prNumber' },
            { prNumber: '$_id.pr' },
            true,
        );

        const merged = this._mergeTierRows<UsageByPrResultContract>(
            rows,
            thresholds,
            (r) => `${r.prNumber}|${r.model}`,
            (base, row) => ({ ...base, prNumber: row.prNumber! }),
        );
        merged.sort((a, b) =>
            a.prNumber === b.prNumber
                ? a.model.localeCompare(b.model)
                : a.prNumber - b.prNumber,
        );
        return merged;
    }

    async getDailyUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageByPrResultContract[]> {
        const thresholds = await this._thresholds();
        const rows = await this._tuRows(
            query,
            thresholds,
            {
                prNumber: '$attributes.prNumber',
                date: {
                    $dateToString: {
                        format: '%Y-%m-%d',
                        date: '$timestamp',
                        timezone: query.timezone || 'UTC',
                    },
                },
            },
            { prNumber: '$_id.prNumber', date: '$_id.date' },
            true,
        );

        const merged = this._mergeTierRows<DailyUsageByPrResultContract>(
            rows,
            thresholds,
            (r) => `${r.prNumber}|${r.date}|${r.model}`,
            (base, row) => ({
                ...base,
                prNumber: row.prNumber!,
                date: row.date!,
            }),
        );
        merged.sort((a, b) => {
            if (a.prNumber !== b.prNumber) return a.prNumber - b.prNumber;
            if (a.date !== b.date) return a.date.localeCompare(b.date);
            return a.model.localeCompare(b.model);
        });
        return merged;
    }

    /**
     * Per review run. One run = one `correlationId` — the ambient
     * observability-context id every usage span of a job inherits (set by the
     * workflow consumer per webhook/job), so a PR reviewed twice shows two
     * rows. Restricted to spans that carry a prNumber (review work), matching
     * the by-PR view's population. `startedAt` (min span timestamp) orders
     * runs chronologically.
     */
    async getUsageByReview(
        query: TokenUsageQueryContract,
    ): Promise<UsageByReviewResultContract[]> {
        const thresholds = await this._thresholds();
        const rows = await this._tuRows(
            query,
            thresholds,
            { review: '$correlationId', pr: '$attributes.prNumber' },
            {
                review: '$_id.review',
                prNumber: '$_id.pr',
                startedAt: 1,
            },
            true,
            // `$gt: ''` = non-empty string; BSON type ordering also excludes
            // docs where correlationId is missing/null.
            { correlationId: { $gt: '' } },
            { startedAt: { $min: '$timestamp' } },
            REVIEW_ROWS_CAP,
        );

        const merged = this._mergeTierRows<UsageByReviewResultContract>(
            rows,
            thresholds,
            (r) => `${r.review}|${r.model}`,
            (base, row) => ({
                ...base,
                review: row.review!,
                prNumber: row.prNumber,
                startedAt:
                    row.startedAt instanceof Date
                        ? row.startedAt.toISOString()
                        : (row.startedAt as string | undefined),
            }),
        );
        merged.sort((a, b) => {
            const t = (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
            return t !== 0 ? t : a.model.localeCompare(b.model);
        });
        return merged;
    }

    /**
     * Per process area (`attributes.tu.area`, stamped by deriveTu and the
     * backfill). Pre-backfill rows without an area land in 'other'.
     */
    async getUsageByArea(
        query: TokenUsageQueryContract,
    ): Promise<UsageByAreaResultContract[]> {
        const thresholds = await this._thresholds();
        const rows = await this._tuRows(
            query,
            thresholds,
            { area: { $ifNull: ['$attributes.tu.area', AREA_FALLBACK] } },
            { area: '$_id.area' },
        );

        const merged = this._mergeTierRows<UsageByAreaResultContract>(
            rows,
            thresholds,
            (r) => `${r.area}|${r.model}`,
            (base, row) => ({ ...base, area: row.area! }),
        );
        merged.sort((a, b) =>
            a.area === b.area
                ? a.model.localeCompare(b.model)
                : a.area!.localeCompare(b.area!),
        );
        return merged;
    }

    /**
     * Single-pass overview: summary + byModel + daily + byPr + dailyByPr in ONE
     * covered aggregation via `$facet`. The org+timestamp+flag scan happens once
     * instead of ~4 separate covered scans (the screen fires summary=2 + daily +
     * by-pr in parallel) — which both cuts wall time and removes the concurrent
     * scan load that caused the prod OOM.
     *
     * A `$project` of ONLY index-covered fields sits before `$facet`: `$facet`
     * is a blocking stage, so without it the `$match` would FETCH full docs to
     * feed the sub-pipelines, defeating the covering. Projecting the tu fields
     * (all in `tu_cover_*`) keeps the scan index-only (docsExamined=0).
     *
     * Numbers are identical to the standalone endpoints — same group math, same
     * baked tier — proven by the golden test.
     */
    async getUsageOverview(query: TokenUsageQueryContract): Promise<{
        summary: UsageSummaryContract;
        byModel: BaseUsageContract[];
        daily: DailyUsageResultContract[];
        byPr: UsageByPrResultContract[];
        byArea: UsageByAreaResultContract[];
    }> {
        const thresholds = await this._thresholds();
        // Project only index fields → $facet works on a lean covered stream.
        // Tier is derived here (from the catalog thresholds) instead of read
        // from a baked field, so it can't drift when pricing tiers change.
        const projectTu = {
            $project: {
                _id: 0,
                model: '$attributes.tu.model',
                tier: this._tierExpr(thresholds),
                pr: '$attributes.prNumber',
                area: { $ifNull: ['$attributes.tu.area', AREA_FALLBACK] },
                date: {
                    $dateToString: {
                        format: '%Y-%m-%d',
                        date: '$timestamp',
                        timezone: query.timezone || 'UTC',
                    },
                },
                input: '$attributes.tu.input',
                output: '$attributes.tu.output',
                total: '$attributes.tu.total',
                reasoning: '$attributes.tu.reasoning',
                cacheRead: '$attributes.tu.cacheRead',
                cacheWrite: '$attributes.tu.cacheWrite',
            },
        };
        const acc = {
            input: { $sum: '$input' },
            output: { $sum: '$output' },
            total: { $sum: '$total' },
            outputReasoning: { $sum: '$reasoning' },
            cacheRead: { $sum: '$cacheRead' },
            cacheWrite: { $sum: '$cacheWrite' },
        };
        const groupProject = (
            groupById: Record<string, any>,
            projectExtras: Record<string, any>,
        ) => [
            {
                $group: {
                    _id: { model: '$model', tier: '$tier', ...groupById },
                    ...acc,
                },
            },
            {
                $project: {
                    ...projectExtras,
                    _id: 0,
                    model: '$_id.model',
                    tier: '$_id.tier',
                    input: 1,
                    output: 1,
                    total: 1,
                    outputReasoning: 1,
                    cacheRead: 1,
                    cacheWrite: 1,
                },
            },
        ];
        // PR facets drop projected rows without a prNumber (matches the
        // standalone getUsageByPr/getDailyUsageByPr prOnly filter).
        const prPresent = { $match: { pr: { $exists: true, $ne: null } } };

        const pipeline = [
            { $match: this._tuMatch(query) },
            projectTu,
            {
                $facet: {
                    byModel: groupProject({}, {}),
                    daily: groupProject({ date: '$date' }, { date: '$_id.date' }),
                    byPr: [
                        prPresent,
                        ...groupProject({ pr: '$pr' }, { prNumber: '$_id.pr' }),
                    ],
                    byArea: groupProject(
                        { area: '$area' },
                        { area: '$_id.area' },
                    ),
                },
            },
        ];

        const [facet] = await this.observabilityTelemetryModel
            .aggregate<{
                byModel: RawAggRow[];
                daily: RawAggRow[];
                byPr: RawAggRow[];
                byArea: RawAggRow[];
            }>(pipeline)
            .exec();

        const rows = facet ?? {
            byModel: [],
            daily: [],
            byPr: [],
            byArea: [],
        };
        // `thresholds` fetched above drives both the tier derivation and the
        // byTier merge — same source, no drift.

        const byModel = this._mergeTierRows(
            rows.byModel,
            thresholds,
            (r) => r.model,
            (base) => base,
        );

        const summary: UsageSummaryContract = {
            model: '',
            input: 0,
            output: 0,
            total: 0,
            outputReasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
        };
        for (const r of rows.byModel) {
            summary.input += r.input;
            summary.output += r.output;
            summary.total += r.total;
            summary.outputReasoning += r.outputReasoning;
            summary.cacheRead = (summary.cacheRead ?? 0) + r.cacheRead;
            summary.cacheWrite = (summary.cacheWrite ?? 0) + r.cacheWrite;
        }

        const daily = this._mergeTierRows<DailyUsageResultContract>(
            rows.daily,
            thresholds,
            (r) => `${r.date}|${r.model}`,
            (base, row) => ({ ...base, date: row.date! }),
        ).sort((a, b) =>
            a.date === b.date
                ? a.model.localeCompare(b.model)
                : a.date.localeCompare(b.date),
        );

        const byPr = this._mergeTierRows<UsageByPrResultContract>(
            rows.byPr,
            thresholds,
            (r) => `${r.prNumber}|${r.model}`,
            (base, row) => ({ ...base, prNumber: row.prNumber! }),
        ).sort((a, b) =>
            a.prNumber === b.prNumber
                ? a.model.localeCompare(b.model)
                : a.prNumber - b.prNumber,
        );

        const byArea = this._mergeTierRows<UsageByAreaResultContract>(
            rows.byArea ?? [],
            thresholds,
            (r) => `${r.area}|${r.model}`,
            (base, row) => ({ ...base, area: row.area! }),
        ).sort((a, b) =>
            a.area === b.area
                ? a.model.localeCompare(b.model)
                : a.area.localeCompare(b.area),
        );

        return { summary, byModel, daily, byPr, byArea };
    }
}

function emptyTier(): TierUsage {
    return {
        input: 0,
        output: 0,
        total: 0,
        outputReasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
    };
}

function addTier(target: TierUsage, src: TierUsage): void {
    target.input += src.input;
    target.output += src.output;
    target.total += src.total;
    target.outputReasoning += src.outputReasoning;
    target.cacheRead += src.cacheRead;
    target.cacheWrite += src.cacheWrite;
}
