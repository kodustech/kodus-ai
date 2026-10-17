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

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<FastifyRequest>();

        try {
            const token = this.extractTokenFromHeader(request.headers);

            if (!token) {
                throw new UnauthorizedException('No token provided');
            }

            // Verify the signature (and expiry) against the orchestrator's JWT
            // secret — the same key that minted this access token. `decode()`
            // only base64-parsed the payload, so any attacker could forge an
            // `organizationId` and impersonate any org.
            const decoded = await this.jwtService.verifyAsync(token);

            if (
                decoded &&
                typeof decoded === 'object' &&
                typeof decoded.organizationId === 'string' &&
                decoded.organizationId.length > 0
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
