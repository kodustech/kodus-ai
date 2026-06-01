import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { IS_PUBLIC_KEY } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';

import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '../interfaces/license.interface';
import { isEnterpriseTierAllowed } from '../tier/enterprise-tier-policy';

/**
 * Rejects enterprise-only endpoints (SSO config, user activity logs)
 * for orgs outside the supported tier. Mirrors the frontend shell
 * gates (sidebar visibility + page-level redirects) so a user with a
 * JWT can't bypass the UI and hit the API directly.
 *
 * Skips `@Public()` handlers — they have no JWT to derive an org from
 * (e.g. the unauthenticated `/user-log/status-change` callback).
 */
@Injectable()
export class EnterpriseTierGuard implements CanActivate {
    private readonly logger = new Logger(EnterpriseTierGuard.name);

    constructor(
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
        private readonly reflector: Reflector,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isPublic = this.reflector.getAllAndOverride<boolean>(
            IS_PUBLIC_KEY,
            [context.getHandler(), context.getClass()],
        );
        if (isPublic) return true;

        const req = context.switchToHttp().getRequest<
            Request & {
                user?: {
                    organizationId?: string;
                    organization?: { uuid?: string };
                };
            }
        >();

        // `UserEntity` exposes the org as `organization: { uuid }` —
        // matches the resolution used by `CockpitTierGuard`.
        const organizationId =
            req.user?.organizationId ?? req.user?.organization?.uuid;

        if (!organizationId) {
            throw new ForbiddenException(
                'enterprise tier: organizationId missing from request',
            );
        }

        try {
            // Tier is an org-level property; teamId is irrelevant here
            // (it only matters for per-seat license assignment). Match
            // the cockpit guard call shape.
            const license =
                await this.licenseService.validateOrganizationLicense({
                    organizationId,
                });
            if (!isEnterpriseTierAllowed(license)) {
                throw new ForbiddenException(
                    'enterprise tier: organization is not on a supported plan',
                );
            }
            return true;
        } catch (err) {
            if (err instanceof ForbiddenException) throw err;
            this.logger.warn(
                `license validation failed for org ${organizationId}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            // Fail-closed: if we can't validate, don't leak data.
            throw new ForbiddenException(
                'enterprise tier: license validation unavailable',
            );
        }
    }
}
