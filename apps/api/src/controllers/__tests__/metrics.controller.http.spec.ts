import {
    CanActivate,
    ExecutionContext,
    INestApplication,
    Injectable,
    ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { GetErrorRatesUseCase } from '@libs/core/metrics/application/use-cases/get-error-rates.use-case';
import { GetMetricsSummaryUseCase } from '@libs/core/metrics/application/use-cases/get-metrics-summary.use-case';
import { GetPipelinePerformanceUseCase } from '@libs/core/metrics/application/use-cases/get-pipeline-performance.use-case';
import { GetReviewResponseTimesUseCase } from '@libs/core/metrics/application/use-cases/get-review-response-times.use-case';
import { PERMISSIONS_SERVICE_TOKEN } from '@libs/identity/domain/permissions/contracts/permissions.service.contract';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { PermissionsAbilityFactory } from '@libs/identity/infrastructure/adapters/services/permissions/permissionsAbility.factory';
import { PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';

import { MetricsController } from '../metrics.controller';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

// Stands in for the global JwtAuthGuard, which answers 401 to a request with no
// valid token before PolicyGuard runs. Past it, the request carries whatever
// user the test sets.
let currentUser: any;

@Injectable()
class InjectUserGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        context.switchToHttp().getRequest().user = currentUser;
        return true;
    }
}

const memberOf = (role: Role) => ({
    uuid: `user-${role}`,
    role,
    status: STATUS.ACTIVE,
    organization: { uuid: 'org-1' },
});

/**
 * The internal metrics routes as a client sees them: a request that reaches the
 * policy check with no member is refused before any metric is read, a member
 * who may read logs gets the metrics, and a window that is not a whole number
 * is a 400.
 * The real PolicyGuard and the same ValidationPipe options as main.ts run here.
 */
describe('MetricsController (HTTP)', () => {
    let app: INestApplication;
    const errorRates = { execute: jest.fn() };
    const responseTimes = { execute: jest.fn() };
    const pipeline = { execute: jest.fn() };
    const summary = { execute: jest.fn() };

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            controllers: [MetricsController],
            providers: [
                PolicyGuard,
                PermissionsAbilityFactory,
                {
                    provide: PERMISSIONS_SERVICE_TOKEN,
                    useValue: {
                        findOne: jest.fn().mockResolvedValue({
                            permissions: { assignedRepositoryIds: [] },
                        }),
                    },
                },
                { provide: APP_GUARD, useClass: InjectUserGuard },
                { provide: GetErrorRatesUseCase, useValue: errorRates },
                {
                    provide: GetReviewResponseTimesUseCase,
                    useValue: responseTimes,
                },
                { provide: GetPipelinePerformanceUseCase, useValue: pipeline },
                { provide: GetMetricsSummaryUseCase, useValue: summary },
            ],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
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

    afterAll(async () => {
        await app?.close();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        errorRates.execute.mockResolvedValue([
            { component: 'api', errorRate: 0.5, total: 2, errors: 1 },
        ]);
        responseTimes.execute.mockResolvedValue({ count: 0 });
        pipeline.execute.mockResolvedValue([]);
        summary.execute.mockResolvedValue({ generatedAt: 'now' });
    });

    const get = (path: string) => request(app.getHttpServer()).get(path);

    it.each([
        '/internal/metrics/error-rates',
        '/internal/metrics/review-response-times',
        '/internal/metrics/pipeline-performance',
        '/internal/metrics/summary',
    ])(
        '%s is 403 when the request carries no member, and reads no metric',
        async (path) => {
            currentUser = undefined;

            await get(path).expect(403);

            for (const useCase of [
                errorRates,
                responseTimes,
                pipeline,
                summary,
            ]) {
                expect(useCase.execute).not.toHaveBeenCalled();
            }
        },
    );

    it.each([
        Role.OWNER,
        Role.REPO_ADMIN,
        Role.BILLING_MANAGER,
        Role.CONTRIBUTOR,
    ])(
        'a %s gets the error rates for the window they asked for',
        async (role) => {
            currentUser = memberOf(role);

            const res = await get(
                '/internal/metrics/error-rates?window=30',
            ).expect(200);

            expect(res.body).toEqual([
                { component: 'api', errorRate: 0.5, total: 2, errors: 1 },
            ]);
            expect(errorRates.execute).toHaveBeenCalledWith({
                windowMinutes: 30,
            });
        },
    );

    it('passes the hours a member asked for to the response-time read', async () => {
        currentUser = memberOf(Role.CONTRIBUTOR);

        await get('/internal/metrics/review-response-times?hours=12').expect(
            200,
        );

        expect(responseTimes.execute).toHaveBeenCalledWith({ hours: 12 });
    });

    it('leaves the window to the use case default when the client sends none', async () => {
        currentUser = memberOf(Role.OWNER);

        await get('/internal/metrics/pipeline-performance').expect(200);

        expect(pipeline.execute).toHaveBeenCalledWith({ hours: undefined });
    });

    it.each([
        '/internal/metrics/error-rates?window=abc',
        '/internal/metrics/error-rates?window=1.5',
        '/internal/metrics/review-response-times?hours=lots',
        '/internal/metrics/error-rates?limit=5',
    ])('%s is a 400 and reads no metric', async (path) => {
        currentUser = memberOf(Role.OWNER);

        await get(path).expect(400);

        expect(errorRates.execute).not.toHaveBeenCalled();
        expect(responseTimes.execute).not.toHaveBeenCalled();
    });
});
