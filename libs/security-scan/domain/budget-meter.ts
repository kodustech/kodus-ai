import type { ModelTokenRates } from '@libs/analytics/domain/token-usage/types/pricing.types';
import { ModelCostCalculator } from '@libs/analytics/application/use-cases/usage/model-cost-calculator';
import type { AiSdkUsage } from '@libs/llm/ai-sdk-usage';
import type {
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
 * counted with the shared tokenizer plus a margin for a provider whose
 * tokenizer counts more, and its answer cap. What was spent, what the
 * requests still in flight may cost, and this request's ceiling must fit
 * under the cap, or the request is refused and the scan stops. Each request
 * carries its own bound, so requests running at once, a planner smaller than
 * a lens, or a new slice never loosen it.
 */
const TOKENIZER_MARGIN = 1.25;

/**
 * The answer a request is assumed to get when it sets no cap of its own: a
 * BYOK slot with a max output tokens gives the exact bound, otherwise a scan
 * request (a tool call or a short JSON object) is reserved at this.
 */
export const UNCAPPED_ANSWER_TOKENS = 32_000;

/** Thrown to the model wrapper for a request the cap has no room for. */
export class ScanBudgetReached extends Error {
    constructor() {
        super('The spend limit of this scan is reached');
        this.name = 'ScanBudgetReached';
    }
}

type Cost = { usd: number; tokens: number };

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

    constructor(
        private readonly budget: SecurityScanBudget,
        /** Null when the model has no known price: then only tokens count. */
        private readonly rates: ModelTokenRates | null,
        initial?: SecurityScanSpend,
    ) {
        this.spent = initial
            ? { ...initial }
            : { usd: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
    }

    admit(request: RequestCeiling): (answered: AiSdkUsage | undefined) => void {
        const input = Math.ceil(request.inputTokens * TOKENIZER_MARGIN);
        const output = request.maxOutputTokens || UNCAPPED_ANSWER_TOKENS;
        const ceiling: Cost = {
            // Input priced at the dearer of a fresh read and a cache write.
            usd: Math.max(
                this.costOf({ inputTokens: input, outputTokens: output }),
                this.costOf({
                    inputTokens: input,
                    outputTokens: output,
                    cacheWriteTokens: input,
                }),
            ),
            tokens: input + output,
        };
        if (this.wouldCross(ceiling)) {
            this.refused = true;
            this.notify();
            throw new ScanBudgetReached();
        }
        this.inFlight = add(this.inFlight, ceiling, 1);

        let settled = false;
        return (usage) => {
            if (settled) return;
            settled = true;
            this.inFlight = add(this.inFlight, ceiling, -1);
            if (usage) {
                this.answered.push({ ...this.cost(usage), key: keyOf(usage) });
            }
        };
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

    private wouldCross(ceiling: Cost): boolean {
        const after = add(this.committed(), ceiling, 1);
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
            0,
        ).total;
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

/** One answer's usage, as the wrapper settles it and its caller records it. */
function keyOf(usage: AiSdkUsage): string {
    return `${usage.inputTokens ?? 0}:${usage.outputTokens ?? 0}`;
}
