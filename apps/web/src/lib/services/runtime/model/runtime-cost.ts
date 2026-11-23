import type { RuntimeUsageReport } from "../contracts";
import { formatTokens } from "./usage-report";

// What the Runtime cost block says about a month: the cost of a Run, the
// calculator and the price basis. Every US$ is an estimate at list price, a
// lower bound, never a price the customer pays; a number with no source is
// "not set", never a zero.

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export type MonthInputs = {
    prs: number | null;
    runsPerPr: number | null;
    costPerRunUsd: number | null;
};

/** The calculator's starting point: the org's own month (PRs and Runs per PR over the listed Runs, the median Run). */
export const monthSeed = (r: RuntimeUsageReport): MonthInputs => {
    const prs = r.counts.prs > 0 ? r.counts.prs : null;
    return {
        prs,
        runsPerPr:
            prs !== null && r.counts.runsListed > 0
                ? Math.round((r.counts.runsListed / prs) * 100) / 100
                : null,
        costPerRunUsd: r.cost.perRun.perCompleteRun?.medianUsd ?? null,
    };
};

const valid = (n: number | null): n is number =>
    n !== null && Number.isFinite(n) && n >= 0;

/** PRs a month × Runs per PR × the cost per Run; null while an input is missing or not a number. */
export const estimateMonth = (i: MonthInputs): number | null =>
    valid(i.prs) && valid(i.runsPerPr) && valid(i.costPerRunUsd)
        ? round6(i.prs * i.runsPerPr * i.costPerRunUsd)
        : null;

/** The cost of a Run as the card shows it, over the Runs priced in full. */
export const costOfRunView = (r: RuntimeUsageReport) => {
    const s = r.cost.perRun;
    const p = s.perCompleteRun;
    if (!p) return null;
    return {
        medianUsd: p.medianUsd,
        maxUsd: p.maxUsd,
        machinesUsd: p.medianMachinesUsd,
        llmManagedUsd: p.medianLlmManagedUsd,
        llmByokUsd: p.medianLlmByokUsd,
        pricedInFull: s.completeRuns,
        runs: s.runs,
    };
};

/** Machine time of the month's setups and previews: not a Run's, so apart from the cost per Run. Null when none ran. */
export const setupsAndPreviews = (r: RuntimeUsageReport) => {
    const rows = r.machine.byConsumer.filter(
        (g) => g.consumer === "setup" || g.consumer === "preview",
    );
    if (!rows.length) return null;
    const sum = (values: Array<number | null>) => {
        const known = values.filter((v): v is number => v !== null);
        return known.length ? round6(known.reduce((n, v) => n + v, 0)) : null;
    };
    return {
        claims: rows.reduce((n, g) => n + g.claims, 0),
        gbMinutes: sum(rows.map((g) => g.gbMinutes)),
        usd: sum(rows.map((g) => g.hostUsd)),
    };
};

/** A rate in US$: four decimals under a dollar, cents above; "not set" when there is none. */
export const formatRate = (usd: number | null | undefined) => {
    if (usd == null || !Number.isFinite(usd)) return "not set";
    return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
};

type PricingModel = RuntimeUsageReport["pricing"]["llmModels"][number];

/** One model's price line: what its tokens cost per 1M this month, and the tier note when some were priced above the base tier. */
export const perMillionLine = (m: PricingModel) => {
    if (m.usdPerMillionTokens === null)
        return "not set: the price list has no price for this model";
    const tier =
        m.aboveBaseTierTokens > 0
            ? `, ${formatTokens(m.aboveBaseTierTokens)} tokens priced at a higher tier`
            : "";
    return `${formatRate(m.usdPerMillionTokens)} per 1M tokens (blended)${tier}`;
};
