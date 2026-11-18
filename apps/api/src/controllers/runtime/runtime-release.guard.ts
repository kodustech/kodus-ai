import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { RUNTIME_RELEASE_GATE, type RuntimeReleaseGate } from '@libs/runtime/api/domain/ports';
import { RUNTIME_PRINCIPAL } from '@libs/runtime/api/infrastructure/runtime-reader.guard';

/**
 * Kody Runtime is an alpha in the feature catalog: an org it is not released to
 * gets 404 on every Runtime route, as for another org's object, so the routes
 * do not advertise an unreleased feature. The org comes from whoever the
 * request's auth established: the JWT user, the Runtime reader principal (team
 * key) or the A2A principal. A request with none passes here and meets its own
 * auth guard, so on a route whose auth is a method guard this guard is listed
 * again after it. The internal routes a cell calls for a Run already accepted
 * (`internal/runtime`) do not carry it.
 */
@Injectable()
export class RuntimeReleaseGuard implements CanActivate {
    constructor(@Inject(RUNTIME_RELEASE_GATE) private readonly release: RuntimeReleaseGate) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const organizationId = organizationOf(context.switchToHttp().getRequest());
        if (!organizationId) return true;
        if (await this.release.isEnabledFor(organizationId)) return true;
        throw new NotFoundException();
    }
}

function organizationOf(req: any): string | undefined {
    const principal = req?.[RUNTIME_PRINCIPAL];
    return (
        principal?.organizationId ??
        principal?.user?.organization?.uuid ??
        req?.runtimeA2APrincipal?.organizationId ??
        req?.user?.organization?.uuid ??
        undefined
    );
}
