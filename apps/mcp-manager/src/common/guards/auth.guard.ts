import {
    Injectable,
    CanActivate,
    ExecutionContext,
    UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FastifyRequest } from 'fastify';

declare module 'fastify' {
    interface FastifyRequest {
        organizationId?: string;
    }
}

@Injectable()
export class AuthGuard implements CanActivate {
    constructor(private readonly jwtService: JwtService) {}

    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<FastifyRequest>();

        try {
            const token = this.extractTokenFromHeader(request.headers);

            if (!token) {
                throw new UnauthorizedException('No token provided');
            }

            const decoded = this.jwtService.decode(token);

            if (
                decoded &&
                typeof decoded === 'object' &&
                'organizationId' in decoded
            ) {
                request.organizationId = decoded.organizationId;
                return true;
            }

            throw new UnauthorizedException('Invalid token');
        } catch (error) {
            throw new UnauthorizedException('Invalid token');
        }
    }

    private extractTokenFromHeader(
        headers: FastifyRequest['headers'],
    ): string | undefined {
        const authHeader = headers.authorization;
        const [type, token] = authHeader?.split(' ') ?? [];
        return type === 'Bearer' ? token : undefined;
    }
}
