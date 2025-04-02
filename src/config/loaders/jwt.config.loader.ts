import { registerAs } from '@nestjs/config';
import { JWT } from '../types/jwt/jwt';

export const jwtConfigLoader = registerAs(
    'jwtConfig',
    (): JWT => ({
        secret: process.env.API_JWT_SECRET,
        expiresIn: process.env.API_JWT_EXPIRES_IN,
        refreshSecret: process.env.API_JWT_REFRESH_SECRET,
        refreshExpiresIn: process.env.API_JWT_REFRESH_EXPIRES_IN,
    }),
);
