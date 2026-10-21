import { Inject, Injectable } from '@nestjs/common';

import { KodusCreditChargeStatus } from '@libs/analytics/infrastructure/adapters/repositories/schemas/kodusCreditCharge.model';

import {
    KODUS_CREDITS_METERING_SERVICE_TOKEN,
    KodusCreditsMeteringService,
} from '../../credits/kodus-credits-metering.service';

/** Filters the usage screen may apply to the journal. */
export type ListKodusCreditChargesQuery = {
    limit?: number;
    /** ISO string from the HTTP layer, or a Date from an internal caller. */
    before?: Date | string;
    prNumber?: number;
};

/**
 * One metered charge as the UI reads it. Deliberately narrower than the stored
 * document: `organizationId` / `teamId` are implied by the caller, and
 * `lastError` / `pricingAsOf` are operational fields the screen never shows.
 */
export type KodusCreditChargeView = {
    spanId: string;
    correlationId?: string;
    prNumber?: number;
    model: string;
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
    status: KodusCreditChargeStatus;
    spanAt: Date;
    debitedAt?: Date;
};

/**
 * Read side of the prepaid-credit metering journal: what the org was charged
 * for on Kodus-routed models, newest first.
 *
 * It exists as a use-case (rather than the controller talking to the metering
 * service) so the transport layer stays a transport layer: the projection of a
 * stored charge into the wire shape is a decision about the product, and the
 * cron, a future export job or a CLI command must all project it the same way.
 */
@Injectable()
export class ListKodusCreditChargesUseCase {
    constructor(
        @Inject(KODUS_CREDITS_METERING_SERVICE_TOKEN)
        private readonly metering: KodusCreditsMeteringService,
    ) {}

    async execute(
        organizationId: string,
        query: ListKodusCreditChargesQuery = {},
    ): Promise<{ charges: KodusCreditChargeView[] }> {
        const charges = await this.metering.listCharges(organizationId, {
            limit: query.limit,
            before: query.before,
            prNumber: query.prNumber,
        });

        return {
            charges: charges.map((charge) => ({
                spanId: charge.spanId,
                correlationId: charge.correlationId,
                prNumber: charge.prNumber,
                model: charge.modelId,
                area: charge.area,
                route: charge.route,
                tokens: charge.tokens,
                amountUsd: charge.amountUsd,
                status: charge.status,
                spanAt: charge.spanAt,
                debitedAt: charge.debitedAt,
            })),
        };
    }
}
