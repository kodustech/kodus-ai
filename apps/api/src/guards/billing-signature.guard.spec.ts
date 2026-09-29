import { createHmac } from 'crypto';

import {
    ExecutionContext,
    InternalServerErrorException,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BillingSignatureGuard } from './billing-signature.guard';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), error: jest.fn() }),
}));

const SECRET = 'test-shared-secret';
const PATH = '/billing/events/plan-changed';

const contextFor = (req: object): ExecutionContext =>
    ({
        switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

const guardWith = (secret: string | undefined) =>
    new BillingSignatureGuard({
        get: () => secret,
    } as unknown as ConfigService);

describe('BillingSignatureGuard', () => {
    const raw = Buffer.from('{"organizationId":"org-1"}');

    const signedRequest = (overrides: Record<string, unknown> = {}) => {
        const timestamp = String(Date.now());
        const signature = createHmac('sha256', SECRET)
            .update(['POST', PATH, '', timestamp, raw.toString()].join('\n'))
            .digest('hex');
        return {
            method: 'POST',
            originalUrl: PATH,
            body: { organizationId: 'org-1' },
            rawBody: raw,
            headers: {
                'x-kodus-signature': signature,
                'x-kodus-timestamp': timestamp,
            },
            ...overrides,
        };
    };

    it('passes a request signed over method, path, timestamp and raw bytes', () => {
        expect(guardWith(SECRET).canActivate(contextFor(signedRequest()))).toBe(
            true,
        );
    });

    it('401 when the same signature targets another path', () => {
        const req = signedRequest({ originalUrl: '/billing/events/credits-low' });
        expect(() => guardWith(SECRET).canActivate(contextFor(req))).toThrow(
            UnauthorizedException,
        );
    });

    // Never verify a re-serialized body: it can differ from the bytes billing
    // signed, and would hide a broken raw-body parser mount.
    it('fails closed (500) when the raw body was not captured', () => {
        const req = signedRequest({ rawBody: undefined });
        expect(() => guardWith(SECRET).canActivate(contextFor(req))).toThrow(
            InternalServerErrorException,
        );
    });

    it('500 when the secret is missing, 401 when the signature is', () => {
        const req = signedRequest({ headers: {} });
        expect(() => guardWith(undefined).canActivate(contextFor(req))).toThrow(
            InternalServerErrorException,
        );
        expect(() => guardWith(SECRET).canActivate(contextFor(req))).toThrow(
            UnauthorizedException,
        );
    });

    it('401 when the signature has a different length (no timingSafeEqual throw)', () => {
        const req = signedRequest();
        req.headers['x-kodus-signature'] = 'short';
        expect(() => guardWith(SECRET).canActivate(contextFor(req))).toThrow(
            UnauthorizedException,
        );
    });
});
