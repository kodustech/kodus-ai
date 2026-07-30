/** Base error for invalid spend-limit configuration (maps to a 4xx). */
export class SpendLimitConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SpendLimitConfigError';
    }
}

/**
 * Raised when enabling a spend limit is blocked because one or more configured
 * models have no resolvable price (no catalog entry and no manual override).
 * A limit can't be enforced for spend it can't measure.
 */
export class SpendLimitPriceabilityError extends SpendLimitConfigError {
    constructor(public readonly unpriceableModels: string[]) {
        super(
            `Cannot enable spend alerts: no price found for ${unpriceableModels.join(
                ', ',
            )}. Enter pricing on the BYOK config to continue.`,
        );
        this.name = 'SpendLimitPriceabilityError';
    }
}
