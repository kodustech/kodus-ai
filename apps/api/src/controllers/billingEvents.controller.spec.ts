import { createHmac } from 'crypto';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as bodyParser from 'body-parser';
import request from 'supertest';

import { SyncRulesOnPlanChangeUseCase } from '@libs/kodyRules/application/use-cases/sync-rules-on-plan-change.use-case';
import { KODY_RULES_SERVICE_TOKEN } from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { EmitBillingNotificationUseCase } from '@libs/notifications/application/use-cases/emit-billing-notification.use-case';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

import { BillingSignatureGuard } from '../guards/billing-signature.guard';
import {
    BILLING_EVENTS_PATH,
    BillingEventsController,
} from './billingEvents.controller';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

const SECRET = 'test-shared-secret';

/** The shared scheme: METHOD\n/path\n<query>\n<timestamp>\n<raw body>. */
const sign = (
    event: string,
    raw: string,
    timestamp: string,
    secret = SECRET,
) =>
    createHmac('sha256', secret)
        .update(
            ['POST', `${BILLING_EVENTS_PATH}/${event}`, '', timestamp, raw].join(
                '\n',
            ),
        )
        .digest('hex');

/**
 * Real HTTP through the controller, the signature guard, both use-cases and
 * the same body parsing as apps/api/src/main.ts (raw-body parser mounted on
 * the billing route, then the generic one, then the global ValidationPipe).
 */
describe('BillingEventsController (HTTP)', () => {
    let app: INestApplication;
    let secret: string | undefined;
    let notify: { emit: jest.Mock };
    let kodyRules: { syncRulesWithPlanLimit: jest.Mock };

    const post = (
        event: string,
        body: object | string,
        signature?: string,
        timestamp: string | undefined = String(Date.now()),
    ) => {
        const raw = typeof body === 'string' ? body : JSON.stringify(body);
        const req = request(app.getHttpServer())
            .post(`${BILLING_EVENTS_PATH}/${event}`)
            .set('Content-Type', 'application/json');
        if (signature !== undefined) req.set('x-kodus-signature', signature);
        if (timestamp !== undefined) req.set('x-kodus-timestamp', timestamp);
        return req.send(raw);
    };
    const signedPost = (event: string, body: object) => {
        const timestamp = String(Date.now());
        return post(
            event,
            body,
            sign(event, JSON.stringify(body), timestamp),
            timestamp,
        );
    };

    beforeEach(async () => {
        secret = SECRET;
        notify = { emit: jest.fn().mockResolvedValue(undefined) };
        kodyRules = {
            syncRulesWithPlanLimit: jest.fn().mockResolvedValue(null),
        };

        const moduleRef = await Test.createTestingModule({
            controllers: [BillingEventsController],
            providers: [
                BillingSignatureGuard,
                EmitBillingNotificationUseCase,
                SyncRulesOnPlanChangeUseCase,
                { provide: NotificationService, useValue: notify },
                { provide: KODY_RULES_SERVICE_TOKEN, useValue: kodyRules },
                {
                    provide: ConfigService,
                    useValue: {
                        get: (key: string) =>
                            key === 'API_BILLING_WEBHOOK_SECRET'
                                ? secret
                                : undefined,
                    },
                },
            ],
        }).compile();

        app = moduleRef.createNestApplication({ bodyParser: false });
        app.use(
            BILLING_EVENTS_PATH,
            bodyParser.json({
                verify: (req: any, _res, buf) => {
                    req.rawBody = buf;
                },
            }),
        );
        app.use(bodyParser.json());
        app.useGlobalPipes(
            new ValidationPipe({
                transform: true,
                whitelist: true,
                forbidNonWhitelisted: true,
                transformOptions: { enableImplicitConversion: true },
            }),
        );
        await app.init();
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await app.close();
    });

    describe('signature', () => {
        it('401 without a signature, and touches nothing', async () => {
            await post('plan-changed', { organizationId: 'org-1' }).expect(401);
            expect(kodyRules.syncRulesWithPlanLimit).not.toHaveBeenCalled();
        });

        it('401 with a wrong signature', async () => {
            await post(
                'payment-failed',
                { organizationId: 'org-1' },
                'deadbeef',
            ).expect(401);
            expect(notify.emit).not.toHaveBeenCalled();
        });

        it('401 when the body was altered after signing', async () => {
            const timestamp = String(Date.now());
            const signature = sign(
                'plan-changed',
                JSON.stringify({ organizationId: 'org-1' }),
                timestamp,
            );
            await post(
                'plan-changed',
                { organizationId: 'org-2' },
                signature,
                timestamp,
            ).expect(401);
        });

        it('401 when a signature for one route is replayed on another', async () => {
            const body = { organizationId: 'org-1' };
            const timestamp = String(Date.now());
            const signature = sign(
                'credits-purchased',
                JSON.stringify(body),
                timestamp,
            );
            await post('plan-changed', body, signature, timestamp).expect(401);
            expect(kodyRules.syncRulesWithPlanLimit).not.toHaveBeenCalled();
        });

        it('401 when the timestamp is missing or outside the 5-minute window', async () => {
            const body = { organizationId: 'org-1' };
            const stale = String(Date.now() - 6 * 60 * 1000);
            await post(
                'plan-changed',
                body,
                sign('plan-changed', JSON.stringify(body), stale),
                stale,
            ).expect(401);
            await post(
                'plan-changed',
                body,
                sign('plan-changed', JSON.stringify(body), ''),
                undefined,
            ).expect(401);
            expect(kodyRules.syncRulesWithPlanLimit).not.toHaveBeenCalled();
        });

        it('500 when the secret is not configured', async () => {
            secret = undefined;
            await signedPost('plan-changed', { organizationId: 'org-1' }).expect(
                500,
            );
        });

        // Cross-service contract: kodus-service-billing sends these exact
        // bytes. The same literal vector is pinned in its
        // src/services/KodusNotificationClient.spec.ts (kodus-service-billing#54)
        // — change both.
        it('accepts the golden vector billing sends', async () => {
            secret = 'golden-vector-secret';
            jest.spyOn(Date, 'now').mockReturnValue(1790000000000);
            await post(
                'plan-changed',
                '{"organizationId":"org-1","teamId":"team-1","planType":"teams_byok","subscriptionStatus":"active"}',
                'a1e66b1c95da6a84331fc3813b4d5c0853d3c0a674080aa3ac4833bfa0fb5297',
                '1790000000000',
            ).expect(200);
            expect(kodyRules.syncRulesWithPlanLimit).toHaveBeenCalledWith({
                organizationId: 'org-1',
                teamId: 'team-1',
            });
        });
    });

    describe('plan-changed', () => {
        it('reconciles the org Kody Rules with the new plan', async () => {
            await signedPost('plan-changed', {
                organizationId: 'org-1',
                teamId: 'team-1',
                planType: 'teams_byok',
            }).expect(200, 'ok');
            expect(kodyRules.syncRulesWithPlanLimit).toHaveBeenCalledWith({
                organizationId: 'org-1',
                teamId: 'team-1',
            });
        });

        it('still 200 when the sync throws (billing never retries)', async () => {
            kodyRules.syncRulesWithPlanLimit.mockRejectedValue(
                new Error('mongo down'),
            );
            await signedPost('plan-changed', { organizationId: 'org-1' }).expect(
                200,
            );
        });

        it('400 without organizationId', async () => {
            await signedPost('plan-changed', { planType: 'free' }).expect(400);
            expect(kodyRules.syncRulesWithPlanLimit).not.toHaveBeenCalled();
        });
    });

    describe('notifications', () => {
        it('payment-failed → BILLING_PAYMENT_FAILED', async () => {
            await signedPost('payment-failed', {
                organizationId: 'org-1',
                amount: 2400,
                currency: 'usd',
                failureReason: 'Card declined: insufficient funds',
                nextRetryAt: '2026-03-05T00:00:00Z',
                updatePaymentUrl: 'https://app.kodus.io/billing',
            }).expect(200);
            expect(notify.emit).toHaveBeenCalledWith({
                event: NotificationEvent.BILLING_PAYMENT_FAILED,
                payload: {
                    amount: 2400,
                    currency: 'usd',
                    failureReason: 'Card declined: insufficient funds',
                    nextRetryAt: '2026-03-05T00:00:00Z',
                    updatePaymentUrl: 'https://app.kodus.io/billing',
                },
                organizationId: 'org-1',
            });
        });

        it('trial-expiring → BILLING_TRIAL_EXPIRING', async () => {
            await signedPost('trial-expiring', {
                organizationId: 'org-1',
                trialEndsAt: '2026-03-12T00:00:00Z',
                daysRemaining: 7,
                upgradeUrl: 'https://app.kodus.io/billing',
            }).expect(200);
            expect(notify.emit).toHaveBeenCalledWith({
                event: NotificationEvent.BILLING_TRIAL_EXPIRING,
                payload: {
                    trialEndsAt: '2026-03-12T00:00:00Z',
                    daysRemaining: 7,
                    upgradeUrl: 'https://app.kodus.io/billing',
                },
                organizationId: 'org-1',
            });
        });

        it('credits-purchased → CREDITS_PURCHASED with the amounts', async () => {
            await signedPost('credits-purchased', {
                organizationId: 'org-1',
                teamId: 't',
                creditUsd: 100,
                balanceUsd: 142.5,
            }).expect(200);
            expect(notify.emit).toHaveBeenCalledWith({
                event: NotificationEvent.CREDITS_PURCHASED,
                payload: { creditUsd: 100, balanceUsd: 142.5 },
                organizationId: 'org-1',
            });
        });

        it('credits-low (not exhausted) → CREDITS_LOW with threshold + top-up link', async () => {
            await signedPost('credits-low', {
                organizationId: 'org-1',
                balanceUsd: 4.2,
                thresholdUsd: 5,
                exhausted: false,
            }).expect(200);
            expect(notify.emit).toHaveBeenCalledWith({
                event: NotificationEvent.CREDITS_LOW,
                payload: {
                    balanceUsd: 4.2,
                    thresholdUsd: 5,
                    topUpUrl: 'https://app.kodus.io/byok#kodus',
                },
                organizationId: 'org-1',
            });
        });

        it('credits-low exhausted → CREDITS_EXHAUSTED (critical, sticky)', async () => {
            await signedPost('credits-low', {
                organizationId: 'org-1',
                balanceUsd: -0.3,
                thresholdUsd: 5,
                exhausted: true,
            }).expect(200);
            expect(notify.emit).toHaveBeenCalledWith({
                event: NotificationEvent.CREDITS_EXHAUSTED,
                payload: {
                    balanceUsd: -0.3,
                    topUpUrl: 'https://app.kodus.io/byok#kodus',
                },
                organizationId: 'org-1',
            });
        });

        // Billing already sends fields this side does not read; the global
        // whitelisting ValidationPipe must not turn them into a 400.
        it('accepts fields it does not know (e.g. autoTopUpError)', async () => {
            await signedPost('credits-low', {
                organizationId: 'org-1',
                balanceUsd: 0,
                thresholdUsd: 5,
                exhausted: true,
                autoTopUpError: 'card_declined',
            }).expect(200);
            expect(notify.emit).toHaveBeenCalled();
        });

        it('still 200 when the notification emit throws (fail-silent)', async () => {
            notify.emit.mockRejectedValueOnce(new Error('outbox down'));
            await signedPost('payment-failed', {
                organizationId: 'org-1',
            }).expect(200);
        });

        it('400 without organizationId, and emits nothing', async () => {
            await signedPost('credits-purchased', { balanceUsd: 0 }).expect(400);
            expect(notify.emit).not.toHaveBeenCalled();
        });
    });
});
