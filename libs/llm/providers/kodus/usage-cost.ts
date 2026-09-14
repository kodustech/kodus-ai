/**
 * List-price cost of one usage record on the Kodus provider — the ONE formula
 * the metering sweep bills with, kept pure and next to the price list it reads.
 *
 * Mirrors `ModelCostCalculator.bucketCost` (libs/analytics): cached tokens are
 * subtracted from the input bucket so they are never billed twice, cache reads
 * and writes get their own rate. Two deliberate simplifications:
 *  - flat rates: no context-length tiers (a >200K Claude/Gemini prompt is
 *    billed at the base rate — Kodus absorbs the tier delta in v1);
 *  - a missing cache rate falls back to the input rate (OpenAI has no cache
 *    write; a provider without a read discount simply pays input price).
 */
import type { CatalogModelPricing } from '../kernel/types';
import { kodusModelPricing } from './catalog';

export interface KodusUsageTokens {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
}

const PER_MILLION = 1_000_000;

const n = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

/** USD, rounded to 6 decimals (the ledger column's precision). */
export function kodusUsageCostUsd(
    tokens: KodusUsageTokens,
    pricing: CatalogModelPricing,
): number {
    const input = n(tokens.input);
    const cacheRead = n(tokens.cacheRead);
    const cacheWrite = n(tokens.cacheWrite);
    const output = n(tokens.output);

    const uncachedInput = Math.max(0, input - cacheRead - cacheWrite);
    const inputRate = pricing.inputPerMillion;
    const cacheReadRate = pricing.cacheReadPerMillion ?? inputRate;
    const cacheWriteRate = pricing.cacheWritePerMillion ?? inputRate;

    const usd =
        (uncachedInput * inputRate +
            cacheRead * cacheReadRate +
            cacheWrite * cacheWriteRate +
            output * pricing.outputPerMillion) /
        PER_MILLION;

    return Math.round(usd * PER_MILLION) / PER_MILLION;
}

/** Cost for a catalog model id, or null when the id is not on the price list
 *  (the sweep journals it as `unpriced` and never debits — an unlisted id
 *  should have been refused at build time, so this is a safety net). */
export function kodusModelUsageCostUsd(
    modelId: string,
    tokens: KodusUsageTokens,
): number | null {
    const pricing = kodusModelPricing(modelId);
    return pricing ? kodusUsageCostUsd(tokens, pricing) : null;
}
