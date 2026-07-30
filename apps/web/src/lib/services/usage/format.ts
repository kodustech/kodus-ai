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
    return `$${amount.toFixed(2)}`;
}
