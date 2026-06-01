import { registerAs } from '@nestjs/config';
import type { StringValue } from 'ms';

import { JWT } from '@libs/core/infrastructure/config/types/jwt/jwt';

const DEFAULT_ACCESS_TOKEN_TTL = '1d';
const DEFAULT_REFRESH_TOKEN_TTL = '7d';

export const jwtConfigLoader = registerAs(
    'jwtConfig',
    (): JWT => ({
        secret: process.env.API_JWT_SECRET,
        expiresIn: (process.env.API_JWT_EXPIRES_IN ??
            DEFAULT_ACCESS_TOKEN_TTL) as StringValue,
        refreshSecret: process.env.API_JWT_REFRESH_SECRET,
        refreshExpiresIn: (process.env.API_JWT_REFRESH_EXPIRES_IN ??
            DEFAULT_REFRESH_TOKEN_TTL) as StringValue,
        helpdeskPrivateKey: process.env.API_JWT_PRIVATE_KEY?.replace(
            /\\n/g,
            '\n',
        ),
    }),
);
