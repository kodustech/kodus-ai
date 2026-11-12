import type { ModelTokenRates } from '@libs/analytics/domain/token-usage/types/pricing.types';
import { ModelCostCalculator } from '@libs/analytics/application/use-cases/usage/model-cost-calculator';
import type { AiSdkUsage } from '@libs/llm/ai-sdk-usage';
import type {
    Admission,
    RequestCeiling,
    UsageMeter,
    UsageObservation,
} from '@libs/llm/usage-meter';

import type { SecurityScanBudget, SecurityScanSpend } from './security-scan.types';

/**
 * Counts what a scan spends and keeps it under the cap the customer set.
 *
 * Every model request is admitted before it leaves (the model wrapper calls
 * `admit`), against the most it can cost: its prompt and tool definitions,
 * bounded by their size in bytes (no model's tokenizer makes more tokens than
 * that), and its answer cap (see SCAN_ANSWER_CAP_TOKENS when it sets none).
 * What was spent, what the requests still in flight may cost, and this
 * request's ceiling must fit under the cap. A request that only the
 * reservations in flight crowd out waits for them to settle; one that does
 * not fit even then is refused and the scan stops. Each request carries its
 * own bound, so requests running at once, a planner smaller than a lens, or a
 * new slice never loosen it.
 */
/** For a caller that sends no byte bound: the shared tokenizer's count, plus a margin. */
const TOKENIZER_MARGIN = 1.25;

/**
 * The answer cap of a request that sets none (a BYOK slot with a max output
 * tokens sets its own): reserved, and sent with the request when the scan has
 * a limit, so the provider cannot answer past it. A scan's answers are tool
 * calls and short JSON objects, reasoning included (the longest measured was
 * about 11k tokens); every current model accepts this cap.
 */
export const SCAN_ANSWER_CAP_TOKENS = 16_000;

/** The least answer cap sent, however full the context window. */
const MIN_ANSWER_CAP_TOKENS = 1_024;

/** Thrown to the model wrapper for a request the cap has no room for. */
export class ScanBudgetReached extends Error {
    constructor() {
        super('The spend limit of this scan is reached');
        this.name = 'ScanBudgetReached';
    }
}

type Cost = { usd: number; tokens: number };
/** A request's most, and the input and answer it was reserved for. */
type Ceiling = Cost & { input: number; output: number; answerCap: number };

export class ScanBudgetMeter implements UsageMeter {
    private spent: SecurityScanSpend;
    /** Ceilings of the requests admitted and not answered yet. */
    private inFlight: Cost = { usd: 0, tokens: 0 };
    /**
     * Requests answered and not recorded yet: the wrapper settles a request
     * before its caller reads the usage and records it.
     */
    private readonly answered: Array<Cost & { key: string }> = [];
    private refused = false;
    private readonly listeners: Array<() => void> = [];
    /** How many requests are in flight. */
    private inFlightCount = 0;
    /** Requests waiting for those in flight to give their room back. */
    private readonly waiting: Array<{
        ceiling: Ceiling;
        request: RequestCeiling;
        resolve: (admission: Admission) => void;
        reject: (error: Error) => void;
    }> = [];

    constructor(
        private readonly budget: SecurityScanBudget,
        /** Null when the model has no known price: then only tokens count. */
        private readonly rates: ModelTokenRates | null,
        initial?: SecurityScanSpend,
        /**
         * The model's context window: the answer cap sent with a request
         * that sets none must fit beside its prompt, or a server with a
         * small window refuses the request outright.
         */
        private readonly contextWindowTokens?: number,
    ) {
        this.spent = initial
            ? { ...initial }
            : { usd: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
    }

    admit(request: RequestCeiling): Admission | Promise<Admission> {
        // Once one is refused, none leaves: the requests aborted then give
        // their reservation back, yet the provider may have billed them.
        if (this.refused) {
            throw new ScanBudgetReached();
        }
        const ceiling = this.ceilingOf(request);
        if (!this.wouldCross(ceiling)) {
            return this.grant(ceiling, request);
        }
        if (this.inFlightCount > 0 && !this.wouldCross(ceiling, false)) {
            return new Promise((resolve, reject) =>
                this.waiting.push({ ceiling, request, resolve, reject }),
            );
        }
        this.refuse();
        throw new ScanBudgetReached();
    }

    /** The most a request can cost: its input bound and its answer cap. */
    private ceilingOf(request: RequestCeiling): Ceiling {
        const input =
            request.inputTokensUpperBound ??
            Math.ceil(request.inputTokens * TOKENIZER_MARGIN);
        const answerCap = request.maxOutputTokens || this.answerCapFor(request);
        // The answer cap, plus any reasoning budget the provider grants on
        // top of it (Anthropic's thinking).
        const output = answerCap + (request.reasoningBudgetTokens ?? 0);
        let usd: number;
        try {
            // Input priced at the dearer of a fresh read and a cache write.
            usd = Math.max(
                this.costOf({ inputTokens: input, outputTokens: output }),
                this.costOf({
                    inputTokens: input,
                    outputTokens: output,
                    cacheWriteTokens: input,
                }),
            );
        } catch {
            usd = Number.NaN;
        }
        return {
            input,
            output,
            answerCap,
            // A price that cannot be computed is no room: never a free pass.
            usd: Number.isFinite(usd) ? usd : Number.POSITIVE_INFINITY,
            tokens: input + output,
        };
    }

    /**
     * The answer cap for a request that sets none: the scan's own, or what
     * the context window leaves beside the prompt when that is less.
     */
    private answerCapFor(request: RequestCeiling): number {
        if (!this.contextWindowTokens) {
            return SCAN_ANSWER_CAP_TOKENS;
        }
        const room =
            this.contextWindowTokens - Math.ceil(request.inputTokens * 1.1);
        return Math.max(
            MIN_ANSWER_CAP_TOKENS,
            Math.min(SCAN_ANSWER_CAP_TOKENS, room),
        );
    }

    private grant(ceiling: Ceiling, request: RequestCeiling): Admission {
        this.inFlight = add(this.inFlight, ceiling, 1);
        this.inFlightCount++;

        let settled = false;
        return {
            ...(!request.maxOutputTokens && this.capped()
                ? { maxOutputTokens: ceiling.answerCap }
                : {}),
            settle: (usage) => {
                if (settled) return;
                settled = true;
                this.inFlight = add(this.inFlight, ceiling, -1);
                this.inFlightCount--;
                if (usage) {
                    this.chargeUnreported(usage, ceiling.input, ceiling.output);
                    this.answered.push({
                        ...this.cost(usage),
                        key: keyOf(usage),
                    });
                }
                this.admitWaiting();
            },
        };
    }

    /** Lets in, in order, the waiting requests that fit now. */
    private admitWaiting(): void {
        while (this.waiting.length) {
            const next = this.waiting[0];
            if (this.refused) {
                break;
            }
            if (!this.wouldCross(next.ceiling)) {
                this.waiting.shift();
                next.resolve(this.grant(next.ceiling, next.request));
                continue;
            }
            if (
                this.inFlightCount > 0 &&
                !this.wouldCross(next.ceiling, false)
            ) {
                return;
            }
            // Nothing left in flight to wait for, and it still does not fit.
            this.refuse();
            break;
        }
        if (this.refused) {
            for (const w of this.waiting.splice(0)) {
                w.reject(new ScanBudgetReached());
            }
        }
    }

    private refuse(): void {
        this.refused = true;
        this.notify();
        for (const w of this.waiting.splice(0)) {
            w.reject(new ScanBudgetReached());
        }
    }

    /**
     * An answer whose provider left a total out was billed all the same:
     * that part is charged at what was reserved for it, never as zero, or a
     * provider that reports no usage would spend past any cap.
     */
    private chargeUnreported(
        usage: AiSdkUsage,
        reservedInput: number,
        reservedOutput: number,
    ): void {
        const unreported = {
            inputTokens: usage.inputTokens === undefined ? reservedInput : 0,
            outputTokens: usage.outputTokens === undefined ? reservedOutput : 0,
        };
        if (!unreported.inputTokens && !unreported.outputTokens) {
            return;
        }
        this.spent = {
            ...this.spent,
            usd:
                this.spent.usd +
                Math.max(
                    this.costOf(unreported),
                    this.costOf({
                        ...unreported,
                        cacheWriteTokens: unreported.inputTokens,
                    }),
                ),
            inputTokens: this.spent.inputTokens + unreported.inputTokens,
            outputTokens: this.spent.outputTokens + unreported.outputTokens,
        };
        if (this.isExhausted()) {
            this.notify();
        }
    }

    /** Whether the scan has a limit this meter can enforce. */
    private capped(): boolean {
        return (
            (this.budget.maxUsd !== undefined && !!this.rates) ||
            this.budget.maxTokens !== undefined
        );
    }

    record(observation: UsageObservation): void {
        const { usage } = observation;
        // Its answer, held since the wrapper settled it, is now spent.
        const held = this.answered.findIndex((a) => a.key === keyOf(usage));
        if (held >= 0) {
            this.answered.splice(held, 1);
        }

        const input = usage.inputTokens ?? 0;
        // ai@7 counts reasoning inside outputTokens, and bills it as output.
        const output = usage.outputTokens ?? 0;
        this.spent = {
            usd: this.spent.usd + this.costOf(usage),
            inputTokens: this.spent.inputTokens + input,
            outputTokens: this.spent.outputTokens + output,
            requests: this.spent.requests + 1,
        };
        if (this.isExhausted()) {
            this.notify();
        }
    }

    /** Called once, the first time a request is refused or the cap is spent. */
    onExhausted(listener: () => void): void {
        if (this.isExhausted()) {
            listener();
            return;
        }
        this.listeners.push(listener);
    }

    isExhausted(): boolean {
        if (this.refused) {
            return true;
        }
        const committed = this.committed();
        return (
            (this.budget.maxUsd !== undefined &&
                !!this.rates &&
                committed.usd >= this.budget.maxUsd) ||
            (this.budget.maxTokens !== undefined &&
                committed.tokens >= this.budget.maxTokens)
        );
    }

    /** Spent, answered and not recorded yet, and still in flight. */
    private committed(): Cost {
        return this.answered.reduce((sum, a) => add(sum, a, 1), {
            usd: this.spent.usd + this.inFlight.usd,
            tokens:
                this.spent.inputTokens +
                this.spent.outputTokens +
                this.inFlight.tokens,
        });
    }

    /** With `withInFlight` false, as if every request in flight was free. */
    private wouldCross(ceiling: Cost, withInFlight = true): boolean {
        const committed = this.committed();
        const after = add(
            withInFlight ? committed : add(committed, this.inFlight, -1),
            ceiling,
            1,
        );
        return (
            (this.budget.maxUsd !== undefined &&
                !!this.rates &&
                after.usd > this.budget.maxUsd) ||
            (this.budget.maxTokens !== undefined &&
                after.tokens > this.budget.maxTokens)
        );
    }

    private notify(): void {
        for (const listener of this.listeners.splice(0)) {
            listener();
        }
    }

    private cost(usage: AiSdkUsage): Cost {
        return {
            usd: this.costOf(usage),
            tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        };
    }

    private costOf(usage: AiSdkUsage): number {
        if (!this.rates) {
            return 0;
        }
        const input = usage.inputTokens ?? 0;
        const output = usage.outputTokens ?? 0;
        return ModelCostCalculator.bucketCost(
            {
                input,
                output,
                total: input + output,
                outputReasoning: usage.reasoningTokens ?? 0,
                cacheRead: usage.cacheReadTokens ?? 0,
                cacheWrite: usage.cacheWriteTokens ?? 0,
            },
            this.rates,
            this.bracketOf(input),
        ).total;
    }

    /**
     * A model priced by context size bills the whole request at the tier its
     * input falls in: how many input thresholds it passes.
     */
    private bracketOf(inputTokens: number): number {
        return (this.rates?.input.tiers ?? []).filter(
            (tier) => inputTokens > tier.threshold,
        ).length;
    }

    snapshot(): SecurityScanSpend {
        return { ...this.spent };
    }
}

/**
 * A limit is optional: without one the scan covers the whole repository. A
 * USD cap needs a price; a model without one (and no manual price on the
 * BYOK config) can only be capped in tokens.
 */
export function validateBudget(
    budget: SecurityScanBudget,
    modelPriced: boolean,
): string | null {
    const hasUsd = typeof budget.maxUsd === 'number';
    const hasTokens = typeof budget.maxTokens === 'number';
    if (hasUsd && !(budget.maxUsd > 0)) {
        return 'The USD limit must be greater than zero.';
    }
    if (hasTokens && !(budget.maxTokens > 0)) {
        return 'The token limit must be greater than zero.';
    }
    if (hasUsd && !hasTokens && !modelPriced) {
        return 'Your model has no known price, so the scan cannot be capped in USD. Set a token limit, or add the model price to your BYOK configuration.';
    }
    return null;
}

function add(a: Cost, b: Cost, sign: 1 | -1): Cost {
    return { usd: a.usd + sign * b.usd, tokens: a.tokens + sign * b.tokens };
}

/**
 * One answer's usage, as the wrapper settles it and its caller records it:
 * every count its cost depends on (the rates are the meter's own), so two
 * answers with one key cost the same and either may be taken for the other.
 */
function keyOf(usage: AiSdkUsage): string {
    return [
        usage.inputTokens,
        usage.outputTokens,
        usage.reasoningTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
    ]
        .map((n) => n ?? 0)
        .join(':');
}
