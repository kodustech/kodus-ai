import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';

import { loadRuntimeApiConfig } from '@libs/runtime/api/infrastructure/runtime-api.config';

/**
 * The Kodus on-call only (RUNTIME_ONCALL_USER_IDS). Anyone else gets 404: the
 * ops routes are not part of the tenant API and do not announce themselves.
 * Runs after the global JWT guard, so `request.user` is the session user.
 */
@Injectable()
export class RuntimeOncallGuard implements CanActivate {
    private readonly oncallUserIds: ReadonlySet<string>;

    constructor() {
        this.oncallUserIds = new Set(loadRuntimeApiConfig().oncallUserIds);
    }

    canActivate(context: ExecutionContext): boolean {
        const userId = context.switchToHttp().getRequest()?.user?.uuid;
        if (typeof userId === 'string' && this.oncallUserIds.has(userId)) return true;
        throw new NotFoundException();
    }
}
