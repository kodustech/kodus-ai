import { STATUS } from '@/config/types/database/status.type';
import { JWT } from '@/config/types/jwt/jwt';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@/core/domain/auth/contracts/auth.service.contracts';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
    protected jwtConfig: JWT;

    constructor(
        private readonly configService: ConfigService,
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
    ) {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: configService.get<JWT>('jwtConfig').secret,
        });

        this.jwtConfig = this.configService.get<JWT>('jwtConfig');
    }

    async validate(payload: any) {
        const user = await this.authService.validateUser({
            email: payload.email,
        });

        if (!user) {
            throw new UnauthorizedException();
        }

        if (user.role !== payload.role) {
            throw new UnauthorizedException();
        }

        if (user.status !== payload.status || user.status === STATUS.REMOVED) {
            throw new UnauthorizedException();
        }

        delete user.password;

        return user;
    }
}
