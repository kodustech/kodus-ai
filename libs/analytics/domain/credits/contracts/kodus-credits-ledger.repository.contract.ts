import type { KodusCreditChargeModel } from '@libs/analytics/infrastructure/adapters/repositories/schemas/kodusCreditCharge.model';

export const KODUS_CREDITS_LEDGER_REPOSITORY_TOKEN = Symbol.for(
    'KodusCreditsLedgerRepository',
);

/** A Kodus-routed usage span, as the sweep reads it. */
export type KodusRoutedSpan = {
    _id: unknown;
    correlationId?: string;
    timestamp?: Date;
    attributes?: Record<string, any>;
};

/** A charge journaled once per span (the span id is its identity). */
export type KodusCreditChargeEntry = {
    spanId: string;
    organizationId: string;
    teamId?: string;
    correlationId?: string;
    prNumber?: number;
    modelId: string;
    area?: string;
    route?: string;
    tokens: {
        input: number;
        output: number;
        reasoning: number;
        cacheRead: number;
        cacheWrite: number;
    };
    amountUsd: number;
    pricingAsOf: string;
    status: 'pending' | 'unpriced';
    spanAt: Date;
};

/** What a journal write inserted: `upsertedIds` is keyed by entry index. */
export type JournalResult = {
    upsertedCount?: number;
    upsertedIds?: Record<string, unknown>;
};

/**
 * The Kodus credits ledger: the usage spans the sweep reads, the charges it
 * journals and debits, and where each organization's sweep stopped.
 */
export interface IKodusCreditsLedgerRepository {
    /** Where the organization's last sweep stopped, if it ever ran. */
    getSweepCursor(organizationId: string): Promise<Date | undefined>;
    saveSweepCursor(
        organizationId: string,
        cursor: Date,
        sweptAt: Date,
    ): Promise<void>;
    /** Kodus-routed spans with token usage in (after, upTo], oldest first. */
    findKodusRoutedSpans(params: {
        organizationId: string;
        after: Date;
        upTo: Date;
        limit: number;
    }): Promise<KodusRoutedSpan[]>;
    /**
     * Inserts each charge whose span is not journaled yet, in one unordered
     * write. Throws the driver's bulk error, which carries `writeErrors` and
     * the partial `result`.
     */
    journalCharges(entries: KodusCreditChargeEntry[]): Promise<JournalResult>;
    /** Pending charges, oldest first. */
    findPendingCharges(
        organizationId: string,
        limit: number,
    ): Promise<Array<KodusCreditChargeModel & { _id: unknown }>>;
    markChargesDebited(spanIds: string[], debitedAt: Date): Promise<void>;
    recordChargeError(spanIds: string[], message: string): Promise<void>;
    /** Charges newest first, optionally before a date or for one PR. */
    listCharges(
        organizationId: string,
        options: { limit: number; before?: Date; prNumber?: number },
    ): Promise<KodusCreditChargeModel[]>;
}
