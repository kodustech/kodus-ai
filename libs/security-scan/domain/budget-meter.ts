import type { ModelTokenRates } from '@libs/analytics/domain/token-usage/types/pricing.types';
import { ModelCostCalculator } from '@libs/analytics/application/use-cases/usage/model-cost-calculator';
import type { UsageMeter, UsageObservation } from '@libs/llm/usage-meter';

import type { SecurityScanBudget, SecurityScanSpend } from './security-scan.types';

/**
 * Counts what a scan spends, request by request, and says when the next
 * request could cross the cap the customer set.
 *
 * "Never exceeds" is held with a reserve: the scan stops once what is spent
 * plus half again the most expensive request seen so far would pass the cap.
 * A request cannot be cancelled halfway, and inside an agent loop each step
 * resends a longer conversation than the one before, so the next request can
 * cost more than any seen. The first request has no history, so it is
 * reserved at `initialReserve`. When several requests run at once, each of
 * them can be that large, so the reserve is taken once per request in flight.
 */
const RESERVE_FACTOR = 1.5;

export class ScanBudgetMeter implements UsageMeter {
    private spent: SecurityScanSpend;
    private largestRequestUsd = 0;
    private largestRequestTokens = 0;
    private inFlight = 1;
    private readonly listeners: Array<() => void> = [];

    constructor(
        private readonly budget: SecurityScanBudget,
        /** Null when the model has no known price: then only tokens count. */
        private readonly rates: ModelTokenRates | null,
        initial?: SecurityScanSpend,
        private readonly initialReserve: { usd: number; tokens: number } = {
            usd: 0,
            tokens: 0,
        },
    ) {
        this.spent = initial
            ? { ...initial }
            : { usd: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
    }

    record(observation: UsageObservation): void {
        const input = observation.usage.inputTokens ?? 0;
        // ai@7 counts reasoning inside outputTokens, and bills it as output.
        const output = observation.usage.outputTokens ?? 0;

        const usd = this.rates
            ? ModelCostCalculator.bucketCost(
                  {
                      input,
                      output,
                      total: input + output,
                      outputReasoning: observation.usage.reasoningTokens ?? 0,
                      cacheRead: observation.usage.cacheReadTokens ?? 0,
                      cacheWrite: observation.usage.cacheWriteTokens ?? 0,
                  },
                  this.rates,
                  0,
              ).total
            : 0;

        this.spent = {
            usd: this.spent.usd + usd,
            inputTokens: this.spent.inputTokens + input,
            outputTokens: this.spent.outputTokens + output,
            requests: this.spent.requests + 1,
        };
        this.largestRequestUsd = Math.max(this.largestRequestUsd, usd);
        this.largestRequestTokens = Math.max(
            this.largestRequestTokens,
            input + output,
        );

        if (this.isExhausted()) {
            for (const listener of this.listeners.splice(0)) {
                listener();
            }
        }
    }

    /** How many requests may be running at once from now on. */
    expectInFlight(requests: number): void {
        this.inFlight = Math.max(1, Math.floor(requests));
    }

    /** Called once, the first time the cap is (about to be) reached. */
    onExhausted(listener: () => void): void {
        if (this.isExhausted()) {
            listener();
            return;
        }
        this.listeners.push(listener);
    }

    isExhausted(): boolean {
        if (this.budget.maxUsd !== undefined && this.rates) {
            const reserve =
                Math.max(
                    this.largestRequestUsd * RESERVE_FACTOR,
                    this.spent.requests ? 0 : this.initialReserve.usd,
                ) * this.inFlight;
            if (this.spent.usd + reserve >= this.budget.maxUsd) {
                return true;
            }
        }
        if (this.budget.maxTokens !== undefined) {
            const reserve =
                Math.max(
                    this.largestRequestTokens * RESERVE_FACTOR,
                    this.spent.requests ? 0 : this.initialReserve.tokens,
                ) * this.inFlight;
            const used = this.spent.inputTokens + this.spent.outputTokens;
            if (used + reserve >= this.budget.maxTokens) {
                return true;
            }
        }
        return false;
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
