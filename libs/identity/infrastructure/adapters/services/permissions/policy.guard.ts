import {
    CanActivate,
    ExecutionContext,
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

const CHECK_POLICIES_KEY = 'check_policy';

export const CheckPolicies = (...handlers: PolicyHandler[]) =>
    SetMetadata(CHECK_POLICIES_KEY, handlers);

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
