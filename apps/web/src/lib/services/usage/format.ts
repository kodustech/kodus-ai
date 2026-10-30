/**
 * Formats a USD amount for compact display. Shared source of truth so the
 * Token Usage (Costs) screen and the BYOK per-model cost chip render an
 * identical value — the chip==Costs invariant
 * (see .planning/features/1395-byok-cost/PLAN.md).
 *
 * Mirrors the original `formatUsd` in token-usage's model-breakdown-table.
 */
export function formatUsd(amount: number): string {
    if (amount >= 1000) {
        const truncated = Math.floor((amount / 1000) * 100) / 100;
        return `$${truncated.toFixed(2)}K`;
    }
    // A priced-but-tiny amount rounds to $0.00 at 2 decimals and reads as "no
    // cost" — so a cheap model with light usage looks unpriced. Reveal the REAL
    // sub-cent magnitude (e.g. $0.0023) instead of a fixed placeholder, so the
    // number shown is the true computed cost, just at finer precision. Genuine
    // zero stays $0.00; anything that rounds to ≥ $0.01 uses the normal 2 dp.
    if (amount > 0 && amount < 0.005) {
        // 4 decimals covers realistic sub-cent spend ($0.0001–$0.0049);
        // below a hundredth of a cent is genuinely negligible.
        return amount >= 0.00005 ? `$${amount.toFixed(4)}` : "<$0.0001";
    }
    return `$${amount.toFixed(2)}`;
}
