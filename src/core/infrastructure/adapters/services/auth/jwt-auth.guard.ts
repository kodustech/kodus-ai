import { isRabbitContext } from '@golevelup/nestjs-rabbitmq';
import {
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    constructor(private reflector: Reflector) {
        super();
    }

    canActivate(context: ExecutionContext) {
        const shouldSkip = isRabbitContext(context);

        if (shouldSkip) {
            return this.handleRpcRequest(context);
        }

        return this.handleHttpRequest(context);
    }

    handleHttpRequest(context: ExecutionContext) {
        const request = context.switchToHttp().getRequest();

        // We can use this to allow public routes;
        const excludePaths = [
            '/health',
            '/health/simple',
            '/auth/refresh',
            '/auth/login',
            '/auth/signup',
            '/auth/forgot-password',
            '/auth/reset-password',
            '/auth/oauth',
            '/user/email',
            '/diagnostic/updateDiagnostic',
            '/github/webhook/installation',
            '/github/integration',
            '/agent/has-active-sessions',
            '/agent/create-session',
            '/agent/router',
            '/agent/memory',
            '/agent/auth-details',
            '/agent/execute-router-prompt',
            '/agent/waiting-columns',
            '/agent/guild-by-member',
            '/agent/auth-details-organization',
            '/agent/metrics',
            '/communication/create-auth-integration',
            '/communication/update-auth-integration',
            '/communication/create-or-update-integration-config',
            '/project-management/create-auth-integration',
            '/code-management/create-auth-integration',
            '/automation/run',
            '/organization/name-by-tenant',
            '/insights',
            '/interaction/users',
            '/daily-checkin-automation/generate-changelog',
            '/daily-checkin-automation/view-delivery-status-items-wip',
            '/daily-checkin-automation/get-insights',
            '/weekly-checkin-automation/get-insights',
            '/agent/has-team-config',
            '/communication/button-disabled',
            '/team/team-infos',
            '/user/invite',
            '/user/invite/complete-invitation',
            '/github/webhook',
            '/snoozed-items/slack',
            '/gitlab/webhook',
            '/bitbucket/webhook',
            '/azure-repos/webhook',
            '/mcp',
            '/user-log/status-change',
            '/kody-rules/find-library-kody-rules',
            '/kody-rules/find-library-kody-rules-buckets',
            '/auth/resend-email',
        ];

        const wildCardExcludePaths = ['/auth/sso/'];

        // Allow access to public routes
        if (
            excludePaths?.includes(request?.path) ||
            wildCardExcludePaths?.some((path) => request?.path.startsWith(path))
        ) {
            return true;
        }

        return super.canActivate(context);
    }

    handleRpcRequest(context: ExecutionContext) {
        const message = context.switchToRpc().getData();

        // if (this.verifyRabbitMQMessage(message)) {
        return true;
        // }

        //throw new ForbiddenException('Forbidden resource');
    }

    handleRequest(err, user) {
        if (err || !user) {
            throw err || new UnauthorizedException('api.users.unauthorized');
        }
        return user;
    }

    private verifyRabbitMQMessage(message: any): boolean {
        if (
            message &&
            message.properties &&
            message.properties.headers &&
            message.properties.headers.authorization
        ) {
            return true;
        }

        return false;
    }
}
