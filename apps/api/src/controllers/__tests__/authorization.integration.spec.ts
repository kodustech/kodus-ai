import {
    CanActivate,
    ExecutionContext,
    INestApplication,
    Injectable,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { PERMISSIONS_SERVICE_TOKEN } from '@libs/identity/domain/permissions/contracts/permissions.service.contract';
import { PermissionsAbilityFactory } from '@libs/identity/infrastructure/adapters/services/permissions/permissionsAbility.factory';
import { PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';

import { TokenUsageController } from '../tokenUsage.controller';
import { CliReviewsController } from '../cli-reviews.controller';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

/**
 * Authorization integration test: boots the REAL controllers with the REAL
 * PolicyGuard + PermissionsAbilityFactory and drives them over HTTP, asserting
 * that each role gets the expected verdict on real routes.
 *
 * We assert the thing the guard actually controls:
 *   - a DENIED role  → 403 (deterministic, before the handler runs)
 *   - an ALLOWED role → NOT 403 (the guard let it through; the handler may then
 *     200/400/500 depending on the auto-mocked deps — we don't care here)
 *
 * The auth layer (JwtAuthGuard) is simulated by a global guard that injects the
 * current test user.
 *
 * Scope note: only "leaf" controllers are mounted here. Heavier controllers
 * (issues, organization-parameters, cockpit, ...) transitively import a module
 * graph with circular module refs that only resolve under a full app bootstrap,
 * so mounting them in isolation throws at load. Their HTTP-path authorization is
 * covered by the full-stack scenario (tests/e2e/scenarios/rbac-authorization).
 */

// Mutated before each request to impersonate a role.
let currentUser: any;

@Injectable()
class InjectUserGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        context.switchToHttp().getRequest().user = currentUser;
        return true;
    }
}

const ALL_ROLES = [
    Role.OWNER,
    Role.BILLING_MANAGER,
    Role.REPO_ADMIN,
    Role.CONTRIBUTOR,
] as const;

type Case = {
    name: string;
    method: 'get' | 'post' | 'delete';
    path: string;
    allowed: Role[];
};

// Expected allow-list per endpoint, derived from ROLE_POLICIES.
const CASES: Case[] = [
    {
        name: 'TokenUsage read',
        method: 'get',
        path: '/usage/tokens/summary',
        allowed: [Role.OWNER, Role.BILLING_MANAGER, Role.REPO_ADMIN],
    },
    {
        name: 'CLI review read',
        method: 'get',
        path: '/cli-reviews/executions',
        allowed: [Role.OWNER, Role.REPO_ADMIN, Role.CONTRIBUTOR],
    },
];

describe('controller authorization (integration)', () => {
    let app: INestApplication;

    beforeAll(async () => {
        const permissionsServiceMock = {
            // The factory reads assignedRepositoryIds to resolve repo-scoped grants.
            findOne: jest.fn().mockResolvedValue({
                permissions: { assignedRepositoryIds: ['repo-1'] },
            }),
        };

        const moduleRef = await Test.createTestingModule({
            controllers: [TokenUsageController, CliReviewsController],
            providers: [
                PolicyGuard,
                PermissionsAbilityFactory,
                {
                    provide: PERMISSIONS_SERVICE_TOKEN,
                    useValue: permissionsServiceMock,
                },
                { provide: APP_GUARD, useClass: InjectUserGuard },
            ],
        })
            // Auto-mock every other controller dependency (use-cases/services).
            .useMocker(() => ({}))
            .compile();

        // logger off: allowed roles reach the handler, where auto-mocked
        // use-cases throw (→ 500). That's expected (still ≠ 403) and we don't
        // want the noise in test output.
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
    });

    afterAll(async () => {
        await app?.close();
    });

    const userFor = (role: Role) => ({
        uuid: `user-${role}`,
        role,
        status: STATUS.ACTIVE,
        organization: { uuid: 'org-1' },
    });

    for (const testCase of CASES) {
        describe(testCase.name, () => {
            for (const role of ALL_ROLES) {
                const shouldAllow = testCase.allowed.includes(role);
                it(`${role} → ${shouldAllow ? 'allowed (not 403)' : '403'}`, async () => {
                    currentUser = userFor(role);
                    const res = await (request(app.getHttpServer()) as any)[
                        testCase.method
                    ](testCase.path);

                    if (shouldAllow) {
                        expect(res.status).not.toBe(403);
                        expect(res.status).not.toBe(401);
                    } else {
                        expect(res.status).toBe(403);
                    }
                });
            }
        });
    }
});
