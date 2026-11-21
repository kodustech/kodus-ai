import { isClaimStateIn, MACHINE_HOLDING_CLAIM_STATES } from '@libs/runtime/contracts/enums';
import type { RuntimeRunProjection } from '@libs/runtime/run/run-projection';

import { type RuntimeLlmAgent, type RuntimeLlmSpendRow, sumLlmSpend } from './llm-spend';

// The cost of one Run: machine time and LLM tokens,
// priced from list prices. Every number here is an estimate. The machine side
// depends on where the Run's claims ran:
//   - a cell whose claims share its host's memory (docker-gvisor):
//     the share of the host each claim held, Σ over the Run's claims of
//     (MB × minutes at its build size + MB × minutes at its ready size)
//     / the MB the cell may commit to claims × the host's US$/h. Time spent
//     waiting for room holds nothing and costs nothing (the hub records a
//     claim only once it is admitted). The host's US$/h is its list price on
//     a Kodus cell (RUNTIME_CELL_PRICES), and on the org's own cell the price
//     per host-hour the org set in Runtime settings (none set: not priced);
//   - an aws-ec2 cell (one VM per claim): the Run's wall time times the list
//     price of the machines the cell is sized with.
// The LLM side is the Run's usage spans (the calls LLM.run recorded, the
// source Token Usage reads), each priced at the tier its prompt fell in
// (domain/llm-spend.ts). What cannot be priced stays null; it is never
// rounded into a zero.

/**
 * On-demand Linux list prices, us-east-1, US$/h, of the instance types the
 * aws-ec2 driver starts (its InstanceType; the driver is not in this tree,
 * the protocol still names the kind). Source: the AWS public price list behind
 * aws.amazon.com/ec2/pricing/on-demand (b0.p.awsstatic.com/pricing/2.0/
 * meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/
 * US East (N. Virginia)/Linux/index.json), published 2026-11-10, read 2026-11-12.
 */
export const AWS_EC2_LIST_PRICES: Readonly<Record<string, number>> = {
    'c7i.large': 0.08925,
    'm7i.large': 0.1008,
    'c7i.xlarge': 0.1785,
    'm7i.xlarge': 0.2016,
    'c7i.2xlarge': 0.357,
    'm7i.2xlarge': 0.4032,
    'm7i.4xlarge': 0.8064,
};

/**
 * Each Run holds two VMs (base and PR) and two observers. An aws-ec2 cell
 * starts each claim's workload at its default size, 4 vCPU / 16 GiB, and its
 * observer at 2 vCPU / 4 GiB (agent/config.go), which InstanceType maps to
 * m7i.xlarge and c7i.large. Ten minutes come to about US$ 0.10.
 */
export const RUNTIME_MACHINE_LIST_PRICES = {
    region: 'us-east-1',
    vm: { instanceType: 'm7i.xlarge', count: 2, usdPerHour: AWS_EC2_LIST_PRICES['m7i.xlarge'] },
    observer: { instanceType: 'c7i.large', count: 2, usdPerHour: AWS_EC2_LIST_PRICES['c7i.large'] },
} as const;

export interface RuntimeMachinePrices {
    region: string;
    vm: { instanceType: string; count: number; usdPerHour: number };
    observer: { instanceType: string; count: number; usdPerHour: number };
}

/**
 * The most an org may set as the price of one hour of its own host (Runtime
 * settings, `machineUsdPerHostHour`): above the on-demand price of any host a
 * cell runs on, so a larger number is a typo, not a host.
 */
export const MAX_USD_PER_HOST_HOUR = 1_000;

/** The driver whose cells give each claim its own VM: priced per machine, for the Run's wall time. */
export const PER_VM_DRIVERS: readonly string[] = ['aws-ec2'];

/**
 * The org's own hosts at the price per host-hour it set (Runtime settings,
 * `machineUsdPerHostHour`): that price, and the cells the org registered
 * (runtime_cells owned by the customer). A claim on any other cell is never
 * priced by it.
 */
export interface OwnHostPrice {
    usdPerHour: number;
    cellIds: ReadonlySet<string>;
}

/** The price of one of the org's own cells, or null for a cell that is not its own (or no price). */
export const ownCellPriceOf =
    (own: OwnHostPrice | undefined) =>
    (cellId: string): { usdPerHour: number } | null =>
        own && own.cellIds.has(cellId) ? { usdPerHour: own.usdPerHour } : null;

/** A Kodus-managed cell's host: what one hour of it costs at list price. */
export interface CellHostPrice {
    instanceType: string;
    usdPerHour: number;
    region: string;
}

/**
 * On-demand Linux list prices of the hosts a shared cell runs on, by instance
 * type. Same price in us-east-1 and us-east-2 (Ohio, where the dev cell runs).
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
    /** vCPUs of the claim's machine size (migration 23); null at the cell's default size or on older rows. */
    cpus?: number | null;
    admittedAt: string | null;
    readyAt: string | null;
    releasedAt: string | null;
    stateChangedAt: string | null;
    hardExpiresAt: string | null;
}

/** Why the machine part is null although the Run held machines. */
export type MachineCostUnpriced = 'missing_claim_facts' | 'cell_price_unknown';

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
         * Null on a customer cell unless the org set its price per host-hour
         * (and always on a per-VM customer cell), and when the Run held
         * machines the product cannot price (`unpriced` says why).
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
        /** shared_cell on the org's own cells: the price per host-hour the org set, which priced `usd`. */
        ownHostUsdPerHour?: number;
        unpriced?: MachineCostUnpriced;
    };
    llm: {
        tokens: number;
        /** Null when some tokens could not be priced (model unknown or not on the price list), or the spans could not be read. */
        usd: number | null;
        /** `telemetry`: the Run's usage spans; `not_measured`: this deployment cannot read them (usd is null). */
        source: 'telemetry' | 'not_measured';
        models: Array<{
            model?: string;
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheWriteTokens: number;
            /** Of these, tokens of calls priced at a tier above the base one (a prompt over the model's threshold). */
            aboveBaseTierTokens: number;
            usd: number | null;
        }>;
        /** By agent: the recipe author, the planner, the Run agent... (domain/llm-spend.ts). */
        agents: Array<{ agent: RuntimeLlmAgent; tokens: number; usd: number | null }>;
        /** Of the priced US$, what the org pays its own provider (BYOK); the rest is Kodus's. */
        customerUsd: number;
        /** Kept for older clients: always 0, a call counts once its span is written. */
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

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * When a claim round stopped holding memory: its release; while it is open,
 * now (never past its ceiling); a round that failed or was refused and is not
 * released yet, when it moved there (the cell let go of it then).
 */
function heldUntil(c: RunClaimUsage, now: Date): number {
    const released = ms(c.releasedAt);
    if (Number.isFinite(released)) return released;
    if (isClaimStateIn(MACHINE_HOLDING_CLAIM_STATES, c.state)) {
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

/** Minutes one claim round held its machines: from admission to its end (now while open). Null without the facts. */
export function claimHeldMinutes(c: RunClaimUsage, now: Date): number | null {
    const from = ms(c.admittedAt);
    const to = heldUntil(c, now);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return Math.max(0, to - from) / MS_PER_MINUTE;
}

/** Minutes one claim round spent building: from admission until ready, or until its end when it never got ready. */
export function claimBuildMinutes(c: RunClaimUsage, now: Date): number | null {
    const from = ms(c.admittedAt);
    const to = heldUntil(c, now);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    const ready = ms(c.readyAt);
    const until = Number.isFinite(ready) ? Math.min(Math.max(ready, from), Math.max(from, to)) : Math.max(from, to);
    return (until - from) / MS_PER_MINUTE;
}

type SharedCellCost<P> = { mbMinutes: number | null; usd: number | null; host?: P & { cellId: string }; unpriced?: MachineCostUnpriced };

/** shared_cell: Σ over the claims of MB·min / allocatable MB × host US$/h ÷ 60, each at its own cell's price. */
export function sharedCellCost<P extends { usdPerHour: number } = CellHostPrice>(claims: readonly RunClaimUsage[], priceOf: (cellId: string) => P | null, now: Date): SharedCellCost<P> {
    let mbMinutes = 0;
    let usd = 0;
    let host: SharedCellCost<P>['host'];
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
    /** The Run's priced usage spans; undefined when they could not be read (the LLM part is "not measured"). */
    spend: readonly RuntimeLlmSpendRow[] | undefined;
    machinePrices?: RuntimeMachinePrices;
    /** The Run's claim rounds as the hub recorded them; undefined when they could not be read. */
    claims?: RunClaimUsage[];
    /** The host price of a Kodus-managed cell (RUNTIME_CELL_PRICES); null when the product has none for it. */
    cellPriceOf?: (cellId: string) => CellHostPrice | null;
    /** The org's own hosts at the price it set; absent: a customer cell's machines are not priced. */
    ownHostPrice?: OwnHostPrice;
    now: Date;
}): RuntimeRunCost {
    const mp = args.machinePrices ?? RUNTIME_MACHINE_LIST_PRICES;
    const minutes = machineMinutesOf(args.run, args.now);
    const paidBy = args.run.cellOwner === 'customer' ? 'customer' : 'kodus';
    const machines = machineCost(args, mp, minutes, paidBy);
    const llm = llmCost(args.spend);

    const machinesUsd = machines.usd;
    const pricedLlm = llm.source === 'telemetry' ? sumLlmSpend(args.spend ?? []).pricedUsd : 0;
    const anyPriced = machinesUsd !== null || pricedLlm > 0 || llm.usd !== null;
    const totalUsd = anyPriced ? round6((machinesUsd ?? 0) + pricedLlm) : null;
    return {
        estimate: true,
        currency: 'USD',
        llmTokens: llm.tokens,
        machines: { minutes, vm: { ...mp.vm }, observer: { ...mp.observer }, region: mp.region, paidBy, ...machines },
        llm,
        totalUsd,
        complete: machinesUsd !== null && llm.usd !== null,
    };
}

/** The LLM part: the spans by model and by agent, priced as the price list prices each call. */
function llmCost(spend: readonly RuntimeLlmSpendRow[] | undefined): RuntimeRunCost['llm'] {
    if (!spend) return { tokens: 0, usd: null, source: 'not_measured', models: [], agents: [], customerUsd: 0, unsettledTokens: 0 };
    const group = <K extends string>(keyOf: (r: RuntimeLlmSpendRow) => K) => {
        const by = new Map<K, RuntimeLlmSpendRow[]>();
        for (const r of spend) by.set(keyOf(r), [...(by.get(keyOf(r)) ?? []), r]);
        return [...by.entries()].map(([k, rows]) => [k, sumLlmSpend(rows)] as const);
    };
    const total = sumLlmSpend(spend);
    return {
        tokens: total.totalTokens,
        usd: total.usd,
        source: 'telemetry',
        models: group((r) => r.model).map(([model, t]) => ({
            ...(model ? { model } : {}),
            inputTokens: t.inputTokens,
            outputTokens: t.outputTokens,
            cacheReadTokens: t.cacheReadTokens,
            cacheWriteTokens: t.cacheWriteTokens,
            aboveBaseTierTokens: t.aboveBaseTierTokens,
            usd: t.usd,
        })),
        agents: group((r) => r.agent).map(([agent, t]) => ({ agent, tokens: t.totalTokens, usd: t.usd })),
        customerUsd: total.customerUsd,
        unsettledTokens: 0,
    };
}

/** The machine part by the Run's claims: per VM on aws-ec2, by held memory on a shared cell, else honest about what is missing. */
function machineCost(
    args: { claims?: RunClaimUsage[]; cellPriceOf?: (cellId: string) => CellHostPrice | null; ownHostPrice?: OwnHostPrice; now: Date },
    mp: RuntimeMachinePrices,
    minutes: number,
    paidBy: 'kodus' | 'customer',
): Pick<RuntimeRunCost['machines'], 'usd' | 'model' | 'mbMinutes' | 'host' | 'ownHostUsdPerHour' | 'unpriced'> {
    const claims = (args.claims ?? []).filter((c) => c.admittedAt || c.driver);
    const perMinute = (mp.vm.count * mp.vm.usdPerHour + mp.observer.count * mp.observer.usdPerHour) / 60;
    if (claims.some((c) => c.driver && PER_VM_DRIVERS.includes(c.driver))) {
        return { model: 'vm', usd: paidBy === 'customer' ? null : round6(minutes * perMinute) };
    }
    if (claims.length && claims.some((c) => c.bootMb != null)) {
        const shared = sharedCellCost(claims, args.cellPriceOf ?? (() => null), args.now);
        if (shared.mbMinutes === null) return { model: 'unknown', usd: null, unpriced: shared.unpriced };
        if (paidBy === 'customer') {
            if (!args.ownHostPrice) return { model: 'shared_cell', mbMinutes: shared.mbMinutes, usd: null };
            // The org's own price, only for the org's own cells: a claim elsewhere leaves the part unpriced.
            const own = sharedCellCost(claims, ownCellPriceOf(args.ownHostPrice), args.now);
            return {
                model: 'shared_cell',
                mbMinutes: shared.mbMinutes,
                usd: own.usd,
                ...(own.usd !== null ? { ownHostUsdPerHour: args.ownHostPrice.usdPerHour } : {}),
                ...(own.unpriced ? { unpriced: own.unpriced } : {}),
            };
        }
        return { model: 'shared_cell', mbMinutes: shared.mbMinutes, usd: shared.usd, ...(shared.host ? { host: shared.host } : {}), ...(shared.unpriced ? { unpriced: shared.unpriced } : {}) };
    }
    // Nothing held yet (a queued Run): nothing to pay. Machines held with no facts to price them: say so, never a guess.
    if (!claims.length && minutes === 0) return { model: 'unknown', usd: paidBy === 'customer' ? null : 0 };
    return { model: 'unknown', usd: null, ...(paidBy === 'customer' ? {} : { unpriced: 'missing_claim_facts' as const }) };
}
