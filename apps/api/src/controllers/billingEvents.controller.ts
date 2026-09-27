import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    UseGuards,
} from '@nestjs/common';

import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import {
    PlanChangedBody,
    SyncRulesOnPlanChangeUseCase,
} from '@libs/kodyRules/application/use-cases/sync-rules-on-plan-change.use-case';
import {
    BillingNotificationBody,
    EmitBillingNotificationUseCase,
} from '@libs/notifications/application/use-cases/emit-billing-notification.use-case';

import { BillingSignatureGuard } from '../guards/billing-signature.guard';

/** Route prefix billing calls, in the one form both consumers use verbatim:
 *  `@Controller` here and the raw-body parser mount in `apps/api/src/main.ts`. */
export const BILLING_EVENTS_PATH = '/billing/events';

/**
 * Receives outbound callbacks from kodus-service-billing.
 *
 * Lives in the API, not in `apps/webhooks`: plan-changed needs the Kody
 * Rules graph and Mongo, which the API already boots and the ingestion
 * service must not (#2007). The path must not contain "webhook" — the ALB
 * routes every `*\/webhook*` path to the webhooks service.
 *
 * `BillingSignatureGuard` authenticates every call. Bodies are typed with
 * interfaces, not DTO classes, so the global whitelisting ValidationPipe does
 * not 400 a callback when billing adds a field.
 */
@Public()
@UseGuards(BillingSignatureGuard)
@Controller(BILLING_EVENTS_PATH)
export class BillingEventsController {
    constructor(
        private readonly emitBillingNotificationUseCase: EmitBillingNotificationUseCase,
        private readonly syncRulesOnPlanChangeUseCase: SyncRulesOnPlanChangeUseCase,
    ) {}

    @Post('/payment-failed')
    @HttpCode(HttpStatus.OK)
    async paymentFailed(@Body() body: BillingNotificationBody): Promise<string> {
        await this.emitBillingNotificationUseCase.execute('payment-failed', body);
        return 'ok';
    }

    @Post('/trial-expiring')
    @HttpCode(HttpStatus.OK)
    async trialExpiring(@Body() body: BillingNotificationBody): Promise<string> {
        await this.emitBillingNotificationUseCase.execute('trial-expiring', body);
        return 'ok';
    }

    @Post('/plan-changed')
    @HttpCode(HttpStatus.OK)
    async planChanged(@Body() body: PlanChangedBody): Promise<string> {
        await this.syncRulesOnPlanChangeUseCase.execute(body);
        return 'ok';
    }

    // ── Prepaid credits ("Kodus as the provider") ────────────────────────

    @Post('/credits-purchased')
    @HttpCode(HttpStatus.OK)
    async creditsPurchased(
        @Body() body: BillingNotificationBody,
    ): Promise<string> {
        await this.emitBillingNotificationUseCase.execute(
            'credits-purchased',
            body,
        );
        return 'ok';
    }

    @Post('/credits-low')
    @HttpCode(HttpStatus.OK)
    async creditsLow(@Body() body: BillingNotificationBody): Promise<string> {
        await this.emitBillingNotificationUseCase.execute('credits-low', body);
        return 'ok';
    }
}
