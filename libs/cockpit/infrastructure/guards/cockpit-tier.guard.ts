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

import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import { IS_PUBLIC_KEY } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';

import { isCockpitTierAllowed } from '../../domain/tier-policy';

/**
 * Rejects cockpit endpoints for orgs outside the supported tier set
 * (see `isCockpitTierAllowed`). Mirrors the frontend shell gate so a
 * user with a JWT can't bypass the page guard and scrape data via a
 * raw HTTP call.
 *
 * Resolves the orgId in this priority order:
 *   1. The JWT-backed user's org — `req.user.organization.uuid` is the
 *      shape `UserEntity` actually exposes; `organizationId` is kept as
 *      a fallback in case future auth flows attach it directly.
 *   2. `req.query.organizationId` as a fallback for endpoints that
 *      receive the id explicitly (e.g. `/cockpit/validate`).
 *
 * Endpoints declared `@Public()` (e.g. `/cockpit/health`,
 * `/cockpit/source/:id`) shouldn't be decorated with this guard —
 * they need to answer without requiring a paid-tier org.
 */
@Injectable()
export class CockpitTierGuard implements CanActivate {
    private readonly logger = new Logger(CockpitTierGuard.name);

    constructor(
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
        private readonly reflector: Reflector,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        // Let class-level `@UseGuards(CockpitTierGuard)` coexist with
        // `@Public()`-decorated probes (`/cockpit/health`, `/cockpit/source/:id`
        // that external monitoring relies on).
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

        // `UserEntity` (libs/identity/.../user.entity.ts) exposes the org as
        // `organization: { uuid }` — there is no flat `organizationId` field.
        // The previous read returned `undefined` for every authenticated
        // request, which made the guard fall through to the query string and
        // 403 any cockpit endpoint that didn't pass `?organizationId=...`.
        const orgFromJwt =
            req.user?.organizationId ?? req.user?.organization?.uuid;

        // Reject non-string inputs outright. Without this the
        // `typeof === 'string'` check below silently coerces arrays
        // (`?organizationId=A&organizationId=A`) to `undefined`, the
        // guard falls through to the JWT org, and the downstream
        // controller still reads the raw array from the query — ORM
        // consumes it and returns data for whichever ids it contains.
        // Belt-and-suspenders against IDOR via array coercion.
        const rawOrg = req.query?.organizationId;
        if (rawOrg !== undefined && typeof rawOrg !== 'string') {
            throw new ForbiddenException(
                'cockpit: organizationId must be a single string',
            );
        }
        const orgFromQuery = rawOrg;

        // IDOR protection: the downstream controllers read
        // `organizationId` from the query string, so if we allowed a
        // JWT for org A to pass a query for org B the tier check would
        // be on A while the data read hits B. Enforce that either the
        // query is absent, or it matches the JWT.
        if (orgFromQuery && orgFromJwt && orgFromQuery !== orgFromJwt) {
            throw new ForbiddenException(
                'cockpit: organizationId in query does not match authenticated user',
            );
        }

        // Prefer the JWT org — it's the only value we can actually
        // trust. The query param is a convenience for endpoints that
        // take it (e.g. `/cockpit/validate?organizationId=...`).
        const organizationId = orgFromJwt ?? orgFromQuery;

        if (!organizationId) {
            throw new ForbiddenException(
                'cockpit: organizationId missing from request',
            );
        }

        try {
            // Tier (Teams / Enterprise / Free) is an org-level property —
            // it applies to the whole org regardless of which team the
            // request is scoped to. teamId only matters for per-seat
            // license assignment, not here. Passing an empty teamId used
            // to break the cloud billing service, which keys subscriptions
            // on (orgId, teamId) and returned `valid: false` for the empty
            // tuple — making prod always fall through to legacy-bq while
            // self-hosted (which ignores teamId in its license JWT) worked.
            const license = await this.licenseService.validateOrganizationLicense({
                organizationId,
            });
            if (!isCockpitTierAllowed(license)) {
                throw new ForbiddenException(
                    'cockpit: organization is not on a supported tier',
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
                'cockpit: license validation unavailable',
            );
        }
    }
}
