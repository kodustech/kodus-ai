import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    SetMetadata,
    Type,
} from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { PermissionsAbilityFactory } from './permissionsAbility.factory';
import {
    IPolicyHandler,
    PolicyHandler,
    PolicyHandlerCallback,
} from '@libs/identity/domain/permissions/types/policy.types';

import { isConnectionScopedReadPolicy } from './policy.handlers';

const CHECK_POLICIES_KEY = 'check_policy';
const APPLIES_CONNECTION_SCOPE_KEY = 'applies_connection_scope';

export const CheckPolicies = (...handlers: PolicyHandler[]) =>
    SetMetadata(CHECK_POLICIES_KEY, handlers);

/**
 * The handler narrows what it reads to the Git connections the member is
 * granted (or reads nothing that belongs to one). Without it, an
 * organization-wide read of connection data is refused to a member granted
 * only some connections.
 */
export const AppliesConnectionScope = () =>
    SetMetadata(APPLIES_CONNECTION_SCOPE_KEY, true);

@Injectable()
export class PolicyGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly abilityFactory: PermissionsAbilityFactory,
        private readonly moduleRef: ModuleRef,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const policyHandlers =
            this.reflector.getAllAndOverride<PolicyHandler[]>(
                CHECK_POLICIES_KEY,
                [context.getHandler(), context.getClass()],
            ) || [];

        const request = context.switchToHttp().getRequest();
        const { user } = request;

        if (!user) {
            return false;
        }

        const ability = await this.abilityFactory.createForUser(user);

        for (const handler of policyHandlers) {
            if (!handler) {
                throw new Error(
                    `One of the policy handlers is undefined. Please check the @CheckPolicies decorator.`,
                );
            }

            if (!(await this.executeHandler(handler, ability, request))) {
                return false;
            }
        }

        if (
            policyHandlers.some(isConnectionScopedReadPolicy) &&
            !this.reflector.getAllAndOverride<boolean>(
                APPLIES_CONNECTION_SCOPE_KEY,
                [context.getHandler(), context.getClass()],
            ) &&
            (await this.abilityFactory.isConnectionRestricted(user))
        ) {
            throw new ForbiddenException(
                'You are granted only some Git connections of the workspace, and this reads all of them.',
            );
        }

        return true;
    }

    private async executeHandler(
        handler: PolicyHandler,
        ability: any,
        request: any,
    ): Promise<boolean> {
        // Check if the handler is a class constructor (an injectable handler)
        if (typeof handler === 'function' && 'prototype' in handler) {
            const instance = this.moduleRef.get(
                handler as Type<IPolicyHandler>,
                { strict: false },
            );

            if (!instance) {
                throw new Error(
                    `Policy handler ${handler.name} is not registered in the module.`,
                );
            }

            return await instance.handle(ability, request);
        }

        // Check if it's an inline function
        if (typeof handler === 'function') {
            return await (handler as PolicyHandlerCallback)(ability, request);
        }

        // It's an instance that implements the interface
        return await handler.handle(ability, request);
    }
}
