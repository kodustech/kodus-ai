import type { ModelTokenRates } from '@libs/analytics/domain/token-usage/types/pricing.types';
import { ModelCostCalculator } from '@libs/analytics/application/use-cases/usage/model-cost-calculator';
import type { AiSdkUsage } from '@libs/llm/ai-sdk-usage';
import type {
    Admission,
    RequestCeiling,
    UsageMeter,
    UsageObservation,
} from '@libs/llm/usage-meter';

import type {
    SecurityScanBudget,
    SecurityScanSpend,
} from './security-scan.types';

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
    /** The same ceilings, as input and answer tokens. */
    private inFlightTokens = { input: 0, output: 0 };
    /** Awaited before each request leaves (see beforeEachRequest). */
    private beforeRequest?: (committed: SecurityScanSpend) => Promise<void>;
    /**
     * Requests answered and not recorded yet: the wrapper settles a request
     * before its caller reads the usage and records it.
     */
    private readonly answered: Array<
        Cost & { key: string; input: number; output: number }
    > = [];
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
            return this.recorded(this.grant(ceiling, request));
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
        // The served model's count, with the margin for a tokenizer that
        // counts more; not the byte bound, which would starve every answer
        // (code runs about four bytes to a token). A prompt that still
        // overflows is refused by the provider and handled as one.
        const room =
            this.contextWindowTokens -
            Math.ceil(request.inputTokens * TOKENIZER_MARGIN);
        return Math.max(
            MIN_ANSWER_CAP_TOKENS,
            Math.min(SCAN_ANSWER_CAP_TOKENS, room),
        );
    }

    private grant(ceiling: Ceiling, request: RequestCeiling): Admission {
        this.inFlight = add(this.inFlight, ceiling, 1);
        this.inFlightTokens.input += ceiling.input;
        this.inFlightTokens.output += ceiling.output;
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
                this.inFlightTokens.input -= ceiling.input;
                this.inFlightTokens.output -= ceiling.output;
                this.inFlightCount--;
                if (usage) {
                    this.chargeUnreported(usage, ceiling.input, ceiling.output);
                    this.answered.push({
                        ...this.cost(usage),
                        input: usage.inputTokens ?? 0,
                        output: usage.outputTokens ?? 0,
                        key: keyOf(usage),
                    });
                }
                this.admitWaiting();
            },
        };
    }

    /**
     * Has `listener` record, before each request leaves, the most the scan
     * may have been billed by then (committedSpend). A request whose record
     * fails is not sent: a worker that dies with requests in flight must
     * leave their reservations on record, or the next slice starts from
     * what was spent and admits past the cap while they are still billed.
     */
    beforeEachRequest(
        listener: (committed: SecurityScanSpend) => Promise<void>,
    ): void {
        this.beforeRequest = listener;
    }

    /** The admission once its reservation is on record. */
    private recorded(admission: Admission): Admission | Promise<Admission> {
        if (!this.beforeRequest) {
            return admission;
        }
        return this.beforeRequest(this.committedSpend()).then(
            () => admission,
            (error) => {
                admission.settle(undefined);
                throw error;
            },
        );
    }

    /**
     * The most the scan may have been billed: spent, answered and not
     * recorded yet, and every request in flight at its ceiling.
     */
    committedSpend(): SecurityScanSpend {
        return {
            usd: this.committed().usd,
            inputTokens:
                this.spent.inputTokens +
                this.inFlightTokens.input +
                this.answered.reduce((sum, a) => sum + a.input, 0),
            outputTokens:
                this.spent.outputTokens +
                this.inFlightTokens.output +
                this.answered.reduce((sum, a) => sum + a.output, 0),
            requests:
                this.spent.requests + this.inFlightCount + this.answered.length,
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
                Promise.resolve(
                    this.recorded(this.grant(next.ceiling, next.request)),
                ).then(next.resolve, next.reject);
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
        const missingInput = usage.inputTokens === undefined;
        const missingOutput = usage.outputTokens === undefined;
        if (!missingInput && !missingOutput) {
            return;
        }
        // The whole request priced as one, at the context tier its input
        // falls in (the reported input, or what was reserved for it): a
        // missing total priced alone would drop to the short-context rate.
        const whole = {
            ...usage,
            inputTokens: missingInput ? reservedInput : usage.inputTokens,
            outputTokens: missingOutput ? reservedOutput : usage.outputTokens,
        };
        const wholeCost = Math.max(
            this.costOf(whole),
            missingInput
                ? this.costOf({ ...whole, cacheWriteTokens: reservedInput })
                : 0,
        );
        // What `record` adds for it later is the reported part alone.
        const unreportedUsd = Math.max(0, wholeCost - this.costOf(usage));
        this.spent = {
            ...this.spent,
            usd: this.spent.usd + unreportedUsd,
            inputTokens:
                this.spent.inputTokens + (missingInput ? reservedInput : 0),
            outputTokens:
                this.spent.outputTokens + (missingOutput ? reservedOutput : 0),
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
