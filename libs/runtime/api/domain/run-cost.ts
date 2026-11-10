import type { RuntimeRunProjection } from '@libs/runtime/run/run-projection';

// The cost of one Run (§11 "Custo", §13 PR 5): machine time and LLM tokens,
// priced from list prices. Every number here is an estimate. The machine side
// depends on where the Run's claims ran:
//   - a cell whose claims share its host's memory (docker-gvisor, ADR-070):
//     the share of the host each claim held, Σ over the Run's claims of
//     (MB × minutes at its build size + MB × minutes at its ready size)
//     / the MB the cell may commit to claims × the host's US$/h. Time spent
//     waiting for room holds nothing and costs nothing (the hub records a
//     claim only once it is admitted);
//   - an aws-ec2 cell (one VM per claim): the Run's wall time times the list
//     price of the machines §11 sizes, as before.
// The LLM side is the tokens the gateway counted times the model's list price.
// What cannot be priced stays null; it is never rounded into a zero.

/**
 * §11: each Run holds two VMs (base and PR) and two observers. List prices in
 * us-east-1, on demand: m7i.2xlarge and t3.medium. Ten minutes come to about
 * US$ 0.15, the "cerca de US$ 0,16" of §11 before the reset time.
 */
export const RUNTIME_MACHINE_LIST_PRICES = {
    region: 'us-east-1',
    vm: { instanceType: 'm7i.2xlarge', count: 2, usdPerHour: 0.4032 },
    observer: { instanceType: 't3.medium', count: 2, usdPerHour: 0.0416 },
} as const;

export interface RuntimeMachinePrices {
    region: string;
    vm: { instanceType: string; count: number; usdPerHour: number };
    observer: { instanceType: string; count: number; usdPerHour: number };
}

/** The driver whose cells give each claim its own VM: priced per machine, for the Run's wall time. */
export const PER_VM_DRIVERS: readonly string[] = ['aws-ec2'];

/** A Kodus-managed cell's host: what one hour of it costs at list price. */
export interface CellHostPrice {
    instanceType: string;
    usdPerHour: number;
    region: string;
}

/**
 * On-demand Linux list prices of the hosts a shared cell runs on, by instance
 * type. Same price in us-east-1 and us-east-2 (Ohio, where cell-dev-1 runs).
 * Source: AWS EC2 On-Demand pricing (aws.amazon.com/ec2/pricing/on-demand),
 * checked 2026-11-07 (instances.vantage.sh/aws/ec2/t4g.xlarge: US$ 0.1344/h,
 * 4 vCPU, 16 GiB). A cell named in RUNTIME_CELL_PRICES with only its
 * instance type takes its price from here.
 */
export const CELL_HOST_LIST_PRICES: Readonly<Record<string, number>> = {
    't4g.large': 0.0672,
    't4g.xlarge': 0.1344,
    't4g.2xlarge': 0.2688,
    'm7i.2xlarge': 0.4032,
};

/**
 * What one acquire round of a claim of the Run held, as the hub recorded it
 * (runtime_claims, migration 11): null where the hub recorded nothing (a row
 * from before, or a cell that reports no memory).
 */
export interface RunClaimUsage {
    claimId: string;
    cellId: string;
    side: string;
    state: string;
    driver: string | null;
    /** MB the claim is counted for while it boots, once ready, and what the cell may commit to claims in all. */
    bootMb: number | null;
    readyMb: number | null;
    allocatableMb: number | null;
    admittedAt: string | null;
    readyAt: string | null;
    releasedAt: string | null;
    stateChangedAt: string | null;
    hardExpiresAt: string | null;
}

/** Why the machine part is null although the Run held machines. */
export type MachineCostUnpriced = 'missing_claim_facts' | 'cell_price_unknown';

/** US$ per token of one model; null when the product cannot price it. */
export type ModelTokenPrice = { input: number; output: number; cacheRead: number; cacheWrite: number } | null;

export interface RunLlmUsageInput {
    /** The budget counter: settled calls plus reservations not settled. */
    tokens: number;
    byModel: Array<{ model?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>;
}

export interface RuntimeRunCost {
    /** Always true: list prices times measured time and counted tokens, never a bill. */
    estimate: true;
    currency: 'USD';
    /** Kept for older clients: the gateway's token counter for the Run. */
    llmTokens: number;
    machines: {
        /** From asking for the machines until the Run finished (or now, while it runs). */
        minutes: number;
        /** Kept for older clients: the per-VM list prices (the `vm` model prices with them). */
        vm: { instanceType: string; count: number; usdPerHour: number };
        observer: { instanceType: string; count: number; usdPerHour: number };
        region: string;
        /**
         * Null on a customer cell (its machines are the customer's, at prices
         * Kodus does not know), and when the Run held machines the product
         * cannot price (`unpriced` says why).
         */
        usd: number | null;
        paidBy: 'kodus' | 'customer';
        /**
         * How the machine time is priced: `shared_cell` by the host memory its
         * claims held, `vm` per VM for the Run's wall time (aws-ec2),
         * `unknown` when the claims' facts are missing.
         */
        model: 'shared_cell' | 'vm' | 'unknown';
        /** shared_cell: MB × minutes the Run's claims held (build size, then ready size). */
        mbMinutes?: number;
        /** shared_cell: the host of the cell the claims ran on, at list price (absent when it has none). */
        host?: CellHostPrice & { cellId: string };
        unpriced?: MachineCostUnpriced;
    };
    llm: {
        tokens: number;
        /** Null when some counted tokens could not be priced (model unknown or not on the price list). */
        usd: number | null;
        models: Array<{ model?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; usd: number | null }>;
        /** Counted on the budget but without a settled call to price (in flight, or lost in a crash). */
        unsettledTokens: number;
    };
    /** Sum of the priced parts; null when nothing could be priced. */
    totalUsd: number | null;
    /** False when a part is missing from totalUsd (a customer cell, unpriced tokens). */
    complete: boolean;
}

const MS_PER_MINUTE = 60_000;
/** Six decimals: the precision of the product's spend ledger; the screen rounds further. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const nonNegative = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/** Minutes the Run held machines: from bootingAt (or startedAt) to finishedAt, or to now while live. */
export function machineMinutesOf(run: Pick<RuntimeRunProjection, 'bootingAt' | 'startedAt' | 'finishedAt'>, now: Date): number {
    const from = Date.parse(run.bootingAt ?? run.startedAt ?? '');
    if (!Number.isFinite(from)) return 0;
    const to = run.finishedAt ? Date.parse(run.finishedAt) : now.getTime();
    return round6(nonNegative((to - from) / MS_PER_MINUTE));
}

/** Cache tokens are part of the input count (ai@7), so they come off the full-price input once. */
export function tokensUsd(
    t: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
    price: NonNullable<ModelTokenPrice>,
): number {
    const cacheRead = nonNegative(t.cacheReadTokens);
    const cacheWrite = nonNegative(t.cacheWriteTokens);
    const uncached = Math.max(0, nonNegative(t.inputTokens) - cacheRead - cacheWrite);
    return uncached * price.input + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite + nonNegative(t.outputTokens) * price.output;
}

const LIVE_CLAIM_STATES = new Set(['pending', 'bound', 'held', 'compromised']);
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * When a claim round stopped holding memory: its release; while it is open,
 * now (never past its ceiling); a round that failed or was refused and is not
 * released yet, when it moved there (the cell let go of it then).
 */
function heldUntil(c: RunClaimUsage, now: Date): number {
    const released = ms(c.releasedAt);
    if (Number.isFinite(released)) return released;
    if (LIVE_CLAIM_STATES.has(c.state)) {
        const ceiling = ms(c.hardExpiresAt);
        return Number.isFinite(ceiling) ? Math.min(now.getTime(), ceiling) : now.getTime();
    }
    const moved = ms(c.stateChangedAt);
    return Number.isFinite(moved) ? moved : NaN;
}

/** MB × minutes one claim round held: its build size until ready (or its end), its ready size after. Null without the facts. */
export function claimMbMinutes(c: RunClaimUsage, now: Date): number | null {
    if (c.bootMb == null || c.readyMb == null) return null;
    const from = ms(c.admittedAt);
    const to = heldUntil(c, now);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    const end = Math.max(from, to);
    const ready = ms(c.readyAt);
    const readyFrom = Number.isFinite(ready) ? Math.min(Math.max(ready, from), end) : end;
    return nonNegative(c.bootMb) * ((readyFrom - from) / MS_PER_MINUTE) + nonNegative(c.readyMb) * ((end - readyFrom) / MS_PER_MINUTE);
}

type SharedCellCost = { mbMinutes: number | null; usd: number | null; host?: CellHostPrice & { cellId: string }; unpriced?: MachineCostUnpriced };

/** shared_cell: Σ over the claims of MB·min / allocatable MB × host US$/h ÷ 60, each at its own cell's price. */
export function sharedCellCost(claims: RunClaimUsage[], priceOf: (cellId: string) => CellHostPrice | null, now: Date): SharedCellCost {
    let mbMinutes = 0;
    let usd = 0;
    let host: SharedCellCost['host'];
    let unpriced: MachineCostUnpriced | undefined;
    for (const c of claims) {
        const held = claimMbMinutes(c, now);
        if (held === null || !c.allocatableMb || c.allocatableMb <= 0) return { mbMinutes: null, usd: null, unpriced: 'missing_claim_facts' };
        mbMinutes += held;
        const price = priceOf(c.cellId);
        if (!price) {
            unpriced = 'cell_price_unknown';
            continue;
        }
        host ??= { cellId: c.cellId, ...price };
        usd += (held / c.allocatableMb) * (price.usdPerHour / 60);
    }
    return { mbMinutes: round6(mbMinutes), usd: unpriced ? null : round6(usd), ...(host ? { host } : {}), ...(unpriced ? { unpriced } : {}) };
}

export function estimateRunCost(args: {
    run: Pick<RuntimeRunProjection, 'bootingAt' | 'startedAt' | 'finishedAt' | 'cellOwner'>;
    usage: RunLlmUsageInput | undefined;
    /** By model id, as `usage.byModel` names them. */
    prices: Map<string, ModelTokenPrice>;
    machinePrices?: RuntimeMachinePrices;
    /** The Run's claim rounds as the hub recorded them; undefined when they could not be read. */
    claims?: RunClaimUsage[];
    /** The host price of a Kodus-managed cell (RUNTIME_CELL_PRICES); null when the product has none for it. */
    cellPriceOf?: (cellId: string) => CellHostPrice | null;
    now: Date;
}): RuntimeRunCost {
    const mp = args.machinePrices ?? RUNTIME_MACHINE_LIST_PRICES;
    const minutes = machineMinutesOf(args.run, args.now);
    const paidBy = args.run.cellOwner === 'customer' ? 'customer' : 'kodus';
    const machines = machineCost(args, mp, minutes, paidBy);

    const usage = args.usage ?? { tokens: 0, byModel: [] };
    const models = usage.byModel.map((m) => {
        const price = m.model ? (args.prices.get(m.model) ?? null) : null;
        const used = m.inputTokens + m.outputTokens > 0;
        return { ...m, usd: price ? round6(tokensUsd(m, price)) : used ? null : 0 };
    });
    const settled = usage.byModel.reduce((n, m) => n + nonNegative(m.inputTokens) + nonNegative(m.outputTokens), 0);
    const unsettledTokens = Math.max(0, nonNegative(usage.tokens) - settled);
    const pricedLlm = models.reduce((n, m) => n + (m.usd ?? 0), 0);
    const llmComplete = unsettledTokens === 0 && models.every((m) => m.usd !== null);
    const llmUsd = llmComplete ? round6(pricedLlm) : null;

    const machinesUsd = machines.usd;
    const anyPriced = machinesUsd !== null || models.some((m) => m.usd !== null && m.usd > 0) || llmUsd !== null;
    const totalUsd = anyPriced ? round6((machinesUsd ?? 0) + pricedLlm) : null;
    return {
        estimate: true,
        currency: 'USD',
        llmTokens: nonNegative(usage.tokens),
        machines: { minutes, vm: { ...mp.vm }, observer: { ...mp.observer }, region: mp.region, paidBy, ...machines },
        llm: { tokens: nonNegative(usage.tokens), usd: llmUsd, models, unsettledTokens },
        totalUsd,
        complete: machinesUsd !== null && llmComplete,
    };
}

/** The machine part by the Run's claims: per VM on aws-ec2, by held memory on a shared cell, else honest about what is missing. */
function machineCost(
    args: { claims?: RunClaimUsage[]; cellPriceOf?: (cellId: string) => CellHostPrice | null; now: Date },
    mp: RuntimeMachinePrices,
    minutes: number,
    paidBy: 'kodus' | 'customer',
): Pick<RuntimeRunCost['machines'], 'usd' | 'model' | 'mbMinutes' | 'host' | 'unpriced'> {
    const claims = (args.claims ?? []).filter((c) => c.admittedAt || c.driver);
    const perMinute = (mp.vm.count * mp.vm.usdPerHour + mp.observer.count * mp.observer.usdPerHour) / 60;
    if (claims.some((c) => c.driver && PER_VM_DRIVERS.includes(c.driver))) {
        return { model: 'vm', usd: paidBy === 'customer' ? null : round6(minutes * perMinute) };
    }
    if (claims.length && claims.some((c) => c.bootMb != null)) {
        const shared = sharedCellCost(claims, args.cellPriceOf ?? (() => null), args.now);
        if (shared.mbMinutes === null) return { model: 'unknown', usd: null, unpriced: shared.unpriced };
        if (paidBy === 'customer') return { model: 'shared_cell', mbMinutes: shared.mbMinutes, usd: null };
        return { model: 'shared_cell', mbMinutes: shared.mbMinutes, usd: shared.usd, ...(shared.host ? { host: shared.host } : {}), ...(shared.unpriced ? { unpriced: shared.unpriced } : {}) };
    }
    // Nothing held yet (a queued Run): nothing to pay. Machines held with no facts to price them: say so, never a guess.
    if (!claims.length && minutes === 0) return { model: 'unknown', usd: paidBy === 'customer' ? null : 0 };
    return { model: 'unknown', usd: null, ...(paidBy === 'customer' ? {} : { unpriced: 'missing_claim_facts' as const }) };
}
