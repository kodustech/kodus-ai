import { isRabbitContext } from '@golevelup/nestjs-rabbitmq';
import {
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './public.decorator';

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
        const isPublic = this.reflector.getAllAndOverride<boolean>(
            IS_PUBLIC_KEY,
            [context.getHandler(), context.getClass()],
        );
        if (isPublic) {
            return true;
        }

        const request = context.switchToHttp().getRequest();

        // We can use this to allow public routes;
        const excludePaths = [
            '/health',
            '/health/ready',
            '/health/simple',
            '/health/live',
            '/auth/refresh',
            '/auth/login',
            '/auth/signup',
            '/auth/forgot-password',
            '/auth/reset-password',
            '/auth/oauth',
            '/user/email',
            '/github/webhook/installation',
            '/github/integration',
            '/code-management/create-auth-integration',
            '/organization/name-by-tenant',
            '/interaction/users',
            '/team/team-infos',
            '/user/invite',
            '/user/invite/complete-invitation',
            '/github/webhook',
            '/gitlab/webhook',
            '/bitbucket/webhook',
            '/azure-repos/webhook',
            '/forgejo/webhook',
            '/user-log/status-change',
            '/kody-rules/find-library-kody-rules',
            '/kody-rules/find-library-kody-rules-buckets',
            '/auth/resend-email',
            '/cli/trial/review',
            '/cli/validate-key',
            '/cli/review',
            '/api/cli/trial/review',
            '/api/cli/validate-key',
            '/api/cli/review',
            '/pull-requests/cli/suggestions',
            '/api/pull-requests/cli/suggestions',
            '/pull-requests/suggestions',
            '/api/pull-requests/suggestions',
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
