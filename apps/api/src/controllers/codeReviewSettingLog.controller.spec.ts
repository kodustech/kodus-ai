import { createHmac } from 'crypto';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as bodyParser from 'body-parser';
import request from 'supertest';

import { FindCodeReviewSettingsLogsUseCase } from '@libs/ee/codeReviewSettingsLog/application/use-cases/find-code-review-settings-logs.use-case';
import { RegisterUserStatusLogUseCase } from '@libs/ee/codeReviewSettingsLog/application/use-cases/register-use-status-log.use-case';
import { EnterpriseTierGuard } from '@libs/ee/license/guards/enterprise-tier.guard';
import { PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';

import { BillingSignatureGuard } from '../guards/billing-signature.guard';
import {
    CodeReviewSettingLogController,
    USER_STATUS_CHANGE_PATH,
} from './codeReviewSettingLog.controller';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

const SECRET = 'test-shared-secret';
const PATH = USER_STATUS_CHANGE_PATH;

const sign = (raw: string, timestamp: string, secret = SECRET) =>
    createHmac('sha256', secret)
        .update(['POST', PATH, '', timestamp, raw].join('\n'))
        .digest('hex');

const body = {
    organizationId: 'org-1',
    teamId: 'team-1',
    gitId: '42',
    gitTool: 'github',
    userName: 'someone',
    licenseStatus: 'active',
    editedBy: { userId: 'u-1', email: 'admin@example.com' },
};

/**
 * `POST /user-log/status-change` is the license-status callback from
 * kodus-service-billing. It is `@Public()` (no user JWT), so the only thing
 * standing between the internet and an org's audit log is the billing
 * signature — the same scheme the billing event callbacks use.
 */
describe('CodeReviewSettingLogController — status-change callback (HTTP)', () => {
    let app: INestApplication;
    let register: { execute: jest.Mock };

    const post = (signature?: string, timestamp?: string) => {
        const req = request(app.getHttpServer())
            .post(PATH)
            .set('Content-Type', 'application/json');
        if (signature !== undefined) req.set('x-kodus-signature', signature);
        if (timestamp !== undefined) req.set('x-kodus-timestamp', timestamp);
        return req.send(JSON.stringify(body));
    };

    beforeEach(async () => {
        register = { execute: jest.fn().mockResolvedValue(undefined) };

        const moduleRef = await Test.createTestingModule({
            controllers: [CodeReviewSettingLogController],
            providers: [
                BillingSignatureGuard,
                { provide: RegisterUserStatusLogUseCase, useValue: register },
                {
                    provide: FindCodeReviewSettingsLogsUseCase,
                    useValue: { execute: jest.fn() },
                },
                {
                    provide: ConfigService,
                    useValue: {
                        get: (key: string) =>
                            key === 'API_BILLING_WEBHOOK_SECRET'
                                ? SECRET
                                : undefined,
                    },
                },
            ],
        })
            .overrideGuard(EnterpriseTierGuard)
            .useValue({ canActivate: () => true })
            .overrideGuard(PolicyGuard)
            .useValue({ canActivate: () => true })
            .compile();

        app = moduleRef.createNestApplication({ bodyParser: false });
        app.use(
            PATH,
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
            }),
        );
        await app.init();
    });

    afterEach(async () => {
        await app?.close();
    });

    it('401 without a signature, and writes nothing to the audit log', async () => {
        await post().expect(401);
        expect(register.execute).not.toHaveBeenCalled();
    });

    it('401 with a signature made with another secret', async () => {
        const timestamp = String(Date.now());
        await post(
            sign(JSON.stringify(body), timestamp, 'wrong-secret'),
            timestamp,
        ).expect(401);
        expect(register.execute).not.toHaveBeenCalled();
    });

    it('writes the entry when billing signed the request', async () => {
        const timestamp = String(Date.now());
        await post(sign(JSON.stringify(body), timestamp), timestamp).expect(
            (res) => expect(res.status).toBeLessThan(300),
        );
        expect(register.execute).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: 'org-1' }),
        );
    });
});
