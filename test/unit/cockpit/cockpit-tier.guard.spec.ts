import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { CockpitTierGuard } from '@libs/cockpit/infrastructure/guards/cockpit-tier.guard';
import {
    ILicenseService,
    SubscriptionStatus,
} from '@libs/ee/license/interfaces/license.interface';

/**
 * Covers the two security-critical shapes of the guard:
 *   - IDOR: a JWT for org A cannot be used to query org B's data even
 *     when the downstream controller reads `organizationId` from the
 *     query string.
 *   - Public bypass: `@Public()` endpoints (health, source-resolver)
 *     must continue to answer without a tier check.
 */

function makeContext(args: {
    jwtOrg?: string;
    /**
     * Shape of the org claim on `req.user`. Real `JwtStrategy.validate`
     * returns a `UserEntity` whose org lives at `organization.uuid`, not
     * a flat `organizationId` — both shapes are exercised here so the
     * guard stays compatible if/when the strategy is changed.
     */
    jwtOrgShape?: 'flat' | 'nested';
    queryOrg?: unknown;
    isPublic?: boolean;
}): {
    ctx: ExecutionContext;
    reflector: Reflector;
} {
    const shape = args.jwtOrgShape ?? 'flat';
    const user = args.jwtOrg
        ? shape === 'nested'
            ? { organization: { uuid: args.jwtOrg } }
            : { organizationId: args.jwtOrg }
        : undefined;
    const req = {
        user,
        query:
            args.queryOrg !== undefined
                ? { organizationId: args.queryOrg }
                : {},
    };
    const ctx = {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => () => undefined,
        getClass: () => class {},
    } as unknown as ExecutionContext;
    const reflector = {
        getAllAndOverride: jest.fn().mockReturnValue(args.isPublic ?? false),
    } as unknown as Reflector;
    return { ctx, reflector };
}

function makeLicenseService(result: {
    valid: boolean;
    subscriptionStatus?: SubscriptionStatus;
    planType?: string;
}): ILicenseService {
    return {
        validateOrganizationLicense: jest.fn().mockResolvedValue(result),
        getAllUsersWithLicense: jest.fn(),
        assignLicenseToUser: jest.fn(),
    } as unknown as ILicenseService;
}

describe('CockpitTierGuard', () => {
    it('lets @Public() endpoints through without hitting the license service', async () => {
        const licenseService = makeLicenseService({ valid: false });
        const { ctx, reflector } = makeContext({
            jwtOrg: undefined,
            isPublic: true,
        });
        const guard = new CockpitTierGuard(licenseService, reflector);

        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(
            licenseService.validateOrganizationLicense,
        ).not.toHaveBeenCalled();
    });

    it('allows access when JWT org matches query org and tier qualifies', async () => {
        const licenseService = makeLicenseService({
            valid: true,
            subscriptionStatus: SubscriptionStatus.ACTIVE,
            planType: 'enterprise_managed',
        });
        const { ctx, reflector } = makeContext({
            jwtOrg: 'org-A',
            queryOrg: 'org-A',
        });
        const guard = new CockpitTierGuard(licenseService, reflector);

        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(
            licenseService.validateOrganizationLicense,
        ).toHaveBeenCalledWith({
            organizationId: 'org-A',
        });
    });

    it('blocks array-coerced organizationId in the query (prevents IDOR via duplicate params)', async () => {
        const licenseService = makeLicenseService({ valid: true });
        const { ctx, reflector } = makeContext({
            jwtOrg: 'org-A',
            // Express parses `?organizationId=X&organizationId=Y` as
            // an array — the previous `typeof === 'string'` check
            // treated it as undefined and fell through to JWT.
            queryOrg: ['org-B', 'org-B'],
        });
        const guard = new CockpitTierGuard(licenseService, reflector);

        await expect(guard.canActivate(ctx)).rejects.toThrow(
            ForbiddenException,
        );
        expect(
            licenseService.validateOrganizationLicense,
        ).not.toHaveBeenCalled();
    });

    it('blocks object-coerced organizationId (Mongo operator injection shape)', async () => {
        const licenseService = makeLicenseService({ valid: true });
        const { ctx, reflector } = makeContext({
            jwtOrg: 'org-A',
            queryOrg: { $ne: null },
        });
        const guard = new CockpitTierGuard(licenseService, reflector);

        await expect(guard.canActivate(ctx)).rejects.toThrow(
            ForbiddenException,
        );
    });

    it('blocks IDOR: JWT for org A, query for org B', async () => {
        const licenseService = makeLicenseService({
            valid: true,
            subscriptionStatus: SubscriptionStatus.ACTIVE,
            planType: 'enterprise_managed',
        });
        const { ctx, reflector } = makeContext({
            jwtOrg: 'org-A',
            queryOrg: 'org-B',
        });
        const guard = new CockpitTierGuard(licenseService, reflector);

        await expect(guard.canActivate(ctx)).rejects.toThrow(
            ForbiddenException,
        );
        // License service must NOT be consulted — the mismatch alone
        // is enough to reject.
        expect(
            licenseService.validateOrganizationLicense,
        ).not.toHaveBeenCalled();
    });

    it('allows queries without an explicit organizationId (uses JWT)', async () => {
        const licenseService = makeLicenseService({
            valid: true,
            subscriptionStatus: SubscriptionStatus.ACTIVE,
            planType: 'teams_managed',
        });
        const { ctx, reflector } = makeContext({
            jwtOrg: 'org-A',
            queryOrg: undefined,
        });
        const guard = new CockpitTierGuard(licenseService, reflector);

        await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('rejects requests missing any organizationId', async () => {
        const licenseService = makeLicenseService({ valid: true });
        const { ctx, reflector } = makeContext({
            jwtOrg: undefined,
            queryOrg: undefined,
        });
        const guard = new CockpitTierGuard(licenseService, reflector);

        await expect(guard.canActivate(ctx)).rejects.toThrow(
            ForbiddenException,
        );
    });

    it('rejects orgs whose tier is not allowed (free_byok)', async () => {
        const licenseService = makeLicenseService({
            valid: true,
            subscriptionStatus: SubscriptionStatus.ACTIVE,
            planType: 'free_byok',
        });
        const { ctx, reflector } = makeContext({ jwtOrg: 'org-A' });
        const guard = new CockpitTierGuard(licenseService, reflector);

        await expect(guard.canActivate(ctx)).rejects.toThrow(
            ForbiddenException,
        );
    });

    it('resolves the org from the nested UserEntity shape (organization.uuid)', async () => {
        // Regression: the previous read of `req.user.organizationId` was
        // always `undefined` because `JwtStrategy.validate` returns a
        // `UserEntity` (organization: { uuid }), not a flat object. That
        // 403'd every cockpit endpoint that didn't pass `?organizationId=`.
        const licenseService = makeLicenseService({
            valid: true,
            subscriptionStatus: SubscriptionStatus.ACTIVE,
            planType: 'enterprise_managed',
        });
        const { ctx, reflector } = makeContext({
            jwtOrg: 'org-A',
            jwtOrgShape: 'nested',
        });
        const guard = new CockpitTierGuard(licenseService, reflector);

        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(
            licenseService.validateOrganizationLicense,
        ).toHaveBeenCalledWith({
            organizationId: 'org-A',
        });
    });

    it('blocks IDOR with the nested UserEntity shape too', async () => {
        const licenseService = makeLicenseService({ valid: true });
        const { ctx, reflector } = makeContext({
            jwtOrg: 'org-A',
            jwtOrgShape: 'nested',
            queryOrg: 'org-B',
        });
        const guard = new CockpitTierGuard(licenseService, reflector);

        await expect(guard.canActivate(ctx)).rejects.toThrow(
            ForbiddenException,
        );
        expect(
            licenseService.validateOrganizationLicense,
        ).not.toHaveBeenCalled();
    });

    it('fails closed when license lookup throws', async () => {
        const licenseService = {
            validateOrganizationLicense: jest
                .fn()
                .mockRejectedValue(new Error('db down')),
        } as unknown as ILicenseService;
        const { ctx, reflector } = makeContext({ jwtOrg: 'org-A' });
        const guard = new CockpitTierGuard(licenseService, reflector);

        await expect(guard.canActivate(ctx)).rejects.toThrow(
            ForbiddenException,
        );
    });
});
