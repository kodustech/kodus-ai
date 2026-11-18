// The org's price per host-hour (PATCH /runtime/settings
// { machineUsdPerHostHour }): what one hour of one of its own hosts costs, in
// US$. With it, the machine time of the org's own cells is priced by the share
// of the host each machine held. Null: those machines are not priced.

/** The most the API takes (libs/runtime/api/domain/run-cost.ts MAX_USD_PER_HOST_HOUR). */
export const MAX_USD_PER_HOST_HOUR = 1_000;

const INVALID = "Enter a price above $0 and at most $1,000.";

/** The field's text as the value to send: null for empty (no price), or why it cannot be sent. */
export const hostPriceDraft = (
    draft: string,
): { usdPerHour: number | null; error?: string } => {
    const text = draft.trim().replace(/^\$/, "");
    if (text === "") return { usdPerHour: null };
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_USD_PER_HOST_HOUR)
        return { usdPerHour: null, error: INVALID };
    return { usdPerHour: n };
};

/** Whether the org's own hosts are priced, in one sentence. */
export const hostPriceWords = (usdPerHour: number | null): string =>
    usdPerHour === null
        ? "Not set: machine time on your own hosts is not priced."
        : `Machine time on your own hosts is priced at $${usdPerHour} per host-hour.`;
