import type {
    BaseUsageContract,
    ModelPricingInfo,
    TokenPrice,
    TierUsage,
} from "@services/usage/types";

export interface RowCost {
    /** Full-price input (uncached input + cache writes). */
    uncachedInput: number;
    /** Discounted cache-read cost (broken out so the chart can show it). */
    cacheRead: number;
    /** Output excluding reasoning. */
    output: number;
    reasoning: number;
    total: number;
}

// Per-token rate for a bracket: bracket 0 → default, bracket k → the k-th
// tier rate (falls back to default when the model has fewer tiers).
const rate = (price: TokenPrice | undefined, bracket: number) =>
    bracket > 0
        ? (price?.tiers?.[bracket - 1]?.rate ?? price?.default ?? 0)
        : (price?.default ?? 0);

/**
 * USD cost of one usage row, per chart series, mirroring the backend's
 * bucketCost formula (model-cost-calculator.ts): cache reads are billed at
 * the cache rate and subtracted from the full-price input pool; reasoning
 * bills at the output rate; tier-aware rows price each byTier bracket at its
 * own rate. Rows without pricing info cost 0 (the per-model table already
 * flags unpriced models).
 */
export function rowCost(
    row: BaseUsageContract,
    info: ModelPricingInfo | undefined,
): RowCost {
    const pricing = info?.pricing;
    const zero = {
        uncachedInput: 0,
        cacheRead: 0,
        output: 0,
        reasoning: 0,
        total: 0,
    };
    if (!pricing) return zero;

    const bucketCost = (bucket: TierUsage, bracket: number) => {
        const uncached = Math.max(0, bucket.input - bucket.cacheRead);
        const uncachedInput =
            uncached * rate(pricing.input, bracket) +
            bucket.cacheWrite * rate(pricing.cacheWrite, bracket);
        const cacheRead = bucket.cacheRead * rate(pricing.cacheRead, bracket);
        const output =
            Math.max(0, bucket.output - bucket.outputReasoning) *
            rate(pricing.output, bracket);
        const reasoning =
            bucket.outputReasoning * rate(pricing.output, bracket);
        return { uncachedInput, cacheRead, output, reasoning };
    };

    const buckets = row.byTier
        ? row.byTier.map((bucket, i) => bucketCost(bucket, i))
        : [
              bucketCost(
                  {
                      input: row.input,
                      output: row.output,
                      total: row.total,
                      outputReasoning: row.outputReasoning,
                      cacheRead: row.cacheRead ?? 0,
                      cacheWrite: row.cacheWrite ?? 0,
                  },
                  0,
              ),
          ];

    const summed = buckets.reduce(
        (acc, b) => ({
            uncachedInput: acc.uncachedInput + b.uncachedInput,
            cacheRead: acc.cacheRead + b.cacheRead,
            output: acc.output + b.output,
            reasoning: acc.reasoning + b.reasoning,
        }),
        { uncachedInput: 0, cacheRead: 0, output: 0, reasoning: 0 },
    );
    return {
        ...summed,
        total:
            summed.uncachedInput +
            summed.cacheRead +
            summed.output +
            summed.reasoning,
    };
}

/**
 * What prompt caching saved vs paying the full input rate for those tokens.
 * Σ over models of cacheRead × (input rate − cache-read rate). Flat-rate
 * approximation (ignores the >200k tier); close enough for the callout.
 */
export function cacheSavings(
    byModel: Array<BaseUsageContract & { model: string }>,
    pricing: Record<string, ModelPricingInfo>,
): number {
    let saved = 0;
    for (const row of byModel) {
        const p = pricing[row.model]?.pricing;
        if (!p) continue;
        const diff = (p.input?.default ?? 0) - (p.cacheRead?.default ?? 0);
        if (diff > 0) saved += (row.cacheRead ?? 0) * diff;
    }
    return saved;
}
