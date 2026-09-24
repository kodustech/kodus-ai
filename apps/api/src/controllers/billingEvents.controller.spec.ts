import { createHmac } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpStatus } from '@nestjs/common';
import { Response } from 'express';

import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { KODY_RULES_SERVICE_TOKEN } from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';

import { BillingEventsController } from './billingEvents.controller';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

const SECRET = 'test-shared-secret';

const sign = (body: object): { rawBody: Buffer; signature: string } => {
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = createHmac('sha256', SECRET)
        .update(rawBody)
        .digest('hex');
    return { rawBody, signature };
};

const makeReq = (
    body: object,
    signature: string | undefined,
    rawBody: Buffer | undefined = Buffer.from(JSON.stringify(body)),
): any => ({
    body,
    rawBody,
    headers: signature ? { 'x-kodus-signature': signature } : {},
});

const makeRes = (): jest.Mocked<Pick<Response, 'status' | 'send' | 'json'>> => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

describe('BillingEventsController', () => {
    let controller: BillingEventsController;
    let notify: jest.Mocked<Pick<NotificationService, 'emit'>>;
    let config: jest.Mocked<Pick<ConfigService, 'get'>>;
    let kodyRules: { syncRulesWithPlanLimit: jest.Mock };

    beforeEach(async () => {
        notify = { emit: jest.fn().mockResolvedValue(undefined) };
        kodyRules = { syncRulesWithPlanLimit: jest.fn().mockResolvedValue(null) };
        config = {
            get: jest
                .fn()
                .mockImplementation((key: string) =>
                    key === 'API_BILLING_WEBHOOK_SECRET' ? SECRET : undefined,
                ),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [BillingEventsController],
            providers: [
                { provide: NotificationService, useValue: notify },
                { provide: ConfigService, useValue: config },
                { provide: KODY_RULES_SERVICE_TOKEN, useValue: kodyRules },
            ],
        }).compile();

        controller = module.get(BillingEventsController);
    });

    describe('signature verification', () => {
        it('rejects requests missing the signature header (401)', async () => {
            const res = makeRes();
            await controller.paymentFailed(
                makeReq(
                    {
                        organizationId: 'org-1',
                        amount: 2400,
                        currency: 'usd',
                        failureReason: 'declined',
                    },
                    undefined,
                ),
                res as unknown as Response,
            );

            expect(res.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
            expect(notify.emit).not.toHaveBeenCalled();
        });

        it('rejects requests with an invalid signature (401)', async () => {
            const res = makeRes();
            await controller.paymentFailed(
                makeReq(
                    {
                        organizationId: 'org-1',
                        amount: 2400,
                        currency: 'usd',
                        failureReason: 'declined',
                    },
                    'deadbeef',
                ),
                res as unknown as Response,
            );

            expect(res.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
            expect(notify.emit).not.toHaveBeenCalled();
        });

        it('refuses (500) instead of re-serializing when the raw body was not captured', async () => {
            const body = { organizationId: 'org-1' };
            const { signature } = sign(body);
            const req = makeReq(body, signature);
            delete req.rawBody;
            const res = makeRes();

            await controller.planChanged(req, res as unknown as Response);

            expect(res.status).toHaveBeenCalledWith(
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
            expect(kodyRules.syncRulesWithPlanLimit).not.toHaveBeenCalled();
        });

        it('rejects when the secret env var is missing (500)', async () => {
            config.get.mockReturnValue(undefined as any);
            const body = { organizationId: 'org-1' };
            const { signature, rawBody } = sign(body);
            const res = makeRes();

            await controller.paymentFailed(
                makeReq(body, signature, rawBody),
                res as unknown as Response,
            );

            expect(res.status).toHaveBeenCalledWith(
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
            expect(notify.emit).not.toHaveBeenCalled();
        });
    });

    describe('payment-failed', () => {
        it('emits billing.payment_failed with role:OWNER + role:BILLING_MANAGER on a valid request', async () => {
            const body = {
                organizationId: 'org-1',
                amount: 2400,
                currency: 'usd',
                failureReason: 'Card declined: insufficient funds',
                nextRetryAt: '2026-03-05T00:00:00Z',
                updatePaymentUrl: 'https://app.kodus.io/billing',
            };
            const { signature, rawBody } = sign(body);
            const res = makeRes();

            await controller.paymentFailed(
                makeReq(body, signature, rawBody),
                res as unknown as Response,
            );

            expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
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

        it('rejects when organizationId is missing (400)', async () => {
            const body = {
                amount: 2400,
                currency: 'usd',
                failureReason: 'declined',
            };
            const { signature, rawBody } = sign(body);
            const res = makeRes();

            await controller.paymentFailed(
                makeReq(body, signature, rawBody),
                res as unknown as Response,
            );

            expect(res.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
            expect(notify.emit).not.toHaveBeenCalled();
        });

        it('still returns 200 when notification emit throws (additive, fail-silent)', async () => {
            notify.emit.mockRejectedValueOnce(new Error('outbox down'));
            const body = {
                organizationId: 'org-1',
                amount: 2400,
                currency: 'usd',
                failureReason: 'declined',
            };
            const { signature, rawBody } = sign(body);
            const res = makeRes();

            await controller.paymentFailed(
                makeReq(body, signature, rawBody),
                res as unknown as Response,
            );

            // 200 so the billing service doesn't think we rejected the
            // webhook and retry forever.
            expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
        });
    });

    describe('trial-expiring', () => {
        it('emits billing.trial_expiring with role:OWNER + role:BILLING_MANAGER', async () => {
            const body = {
                organizationId: 'org-1',
                trialEndsAt: '2026-03-12T00:00:00Z',
                daysRemaining: 7,
                upgradeUrl: 'https://app.kodus.io/billing',
            };
            const { signature, rawBody } = sign(body);
            const res = makeRes();

            await controller.trialExpiring(
                makeReq(body, signature, rawBody),
                res as unknown as Response,
            );

            expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
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
    });

    describe('plan-changed', () => {
        it('reconciles the org Kody Rules with the new plan', async () => {
            const body = {
                organizationId: 'org-1',
                teamId: 'team-1',
                planType: 'teams_byok',
            };
            const { signature, rawBody } = sign(body);
            const res = makeRes();

            await controller.planChanged(
                makeReq(body, signature, rawBody),
                res as unknown as Response,
            );

            expect(kodyRules.syncRulesWithPlanLimit).toHaveBeenCalledWith({
                organizationId: 'org-1',
                teamId: 'team-1',
            });
            expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
        });

        // Cross-service contract: kodus-service-billing sends these exact
        // bytes. The same literal vector is pinned in its
        // src/services/KodusNotificationClient.spec.ts (added in
        // kodustech/kodus-service-billing#54) — change both.
        it('accepts the golden vector billing sends', async () => {
            config.get.mockImplementation((key: string) =>
                key === 'API_BILLING_WEBHOOK_SECRET'
                    ? 'golden-vector-secret'
                    : undefined,
            );
            const rawBody = Buffer.from(
                '{"organizationId":"org-1","teamId":"team-1","planType":"teams_byok","subscriptionStatus":"active"}',
            );
            const res = makeRes();

            await controller.planChanged(
                makeReq(
                    JSON.parse(rawBody.toString()),
                    'dc0921843a6b8747d3750476608ef2fe4089b94b14963bae7792c0814eaae023',
                    rawBody,
                ),
                res as unknown as Response,
            );

            expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
            expect(kodyRules.syncRulesWithPlanLimit).toHaveBeenCalledWith({
                organizationId: 'org-1',
                teamId: 'team-1',
            });
        });

        it('still returns 200 when the sync throws (billing never retries)', async () => {
            kodyRules.syncRulesWithPlanLimit.mockRejectedValue(
                new Error('mongo down'),
            );
            const body = { organizationId: 'org-1' };
            const { signature, rawBody } = sign(body);
            const res = makeRes();

            await controller.planChanged(
                makeReq(body, signature, rawBody),
                res as unknown as Response,
            );

            expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
        });

        it('rejects an unsigned request (401) without touching the rules', async () => {
            const res = makeRes();

            await controller.planChanged(
                makeReq({ organizationId: 'org-1' }, undefined),
                res as unknown as Response,
            );

            expect(res.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
            expect(kodyRules.syncRulesWithPlanLimit).not.toHaveBeenCalled();
        });
    });

    describe('prepaid credits webhooks', () => {
        it('credits-purchased → CREDITS_PURCHASED with the amounts', async () => {
            const body = { organizationId: 'org-1', teamId: 't', creditUsd: 100, balanceUsd: 142.5 };
            const { signature, rawBody } = sign(body);
            const res = makeRes();

            await controller.creditsPurchased(
                makeReq(body, signature, rawBody),
                res as unknown as Response,
            );

            expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
            expect(notify.emit).toHaveBeenCalledWith({
                event: NotificationEvent.CREDITS_PURCHASED,
                payload: { creditUsd: 100, balanceUsd: 142.5 },
                organizationId: 'org-1',
            });
        });

        it('credits-low (not exhausted) → CREDITS_LOW with threshold + top-up link', async () => {
            const body = { organizationId: 'org-1', balanceUsd: 4.2, thresholdUsd: 5, exhausted: false };
            const { signature, rawBody } = sign(body);
            const res = makeRes();

            await controller.creditsLow(
                makeReq(body, signature, rawBody),
                res as unknown as Response,
            );

            expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
            expect(notify.emit).toHaveBeenCalledWith({
                event: NotificationEvent.CREDITS_LOW,
                payload: expect.objectContaining({ balanceUsd: 4.2, thresholdUsd: 5, topUpUrl: expect.stringContaining('/byok#kodus') }),
                organizationId: 'org-1',
            });
        });

        it('credits-low with exhausted=true → CREDITS_EXHAUSTED (critical, sticky)', async () => {
            const body = { organizationId: 'org-1', balanceUsd: -0.3, thresholdUsd: 5, exhausted: true };
            const { signature, rawBody } = sign(body);
            const res = makeRes();

            await controller.creditsLow(
                makeReq(body, signature, rawBody),
                res as unknown as Response,
            );

            expect(notify.emit).toHaveBeenCalledWith({
                event: NotificationEvent.CREDITS_EXHAUSTED,
                payload: expect.objectContaining({ balanceUsd: -0.3 }),
                organizationId: 'org-1',
            });
        });

        it('rejects an unsigned credits webhook (401) and a missing org (400)', async () => {
            const res1 = makeRes();
            await controller.creditsLow(
                makeReq({ organizationId: 'org-1', balanceUsd: 0 }, undefined),
                res1 as unknown as Response,
            );
            expect(res1.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);

            const body = { balanceUsd: 0 };
            const { signature, rawBody } = sign(body);
            const res2 = makeRes();
            await controller.creditsPurchased(
                makeReq(body, signature, rawBody),
                res2 as unknown as Response,
            );
            expect(res2.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
            expect(notify.emit).not.toHaveBeenCalled();
        });
    });
});
