import { createHmac } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpStatus } from '@nestjs/common';
import { Response } from 'express';

import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

import { BillingController } from './billing.controller';

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

describe('BillingController', () => {
    let controller: BillingController;
    let notify: jest.Mocked<Pick<NotificationService, 'emit'>>;
    let config: jest.Mocked<Pick<ConfigService, 'get'>>;

    beforeEach(async () => {
        notify = { emit: jest.fn().mockResolvedValue(undefined) };
        config = {
            get: jest
                .fn()
                .mockImplementation((key: string) =>
                    key === 'API_BILLING_WEBHOOK_SECRET' ? SECRET : undefined,
                ),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [BillingController],
            providers: [
                { provide: NotificationService, useValue: notify },
                { provide: ConfigService, useValue: config },
            ],
        }).compile();

        controller = module.get(BillingController);
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
});
