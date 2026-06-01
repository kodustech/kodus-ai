import type { StringValue } from 'ms';

export type JWT = {
    secret: string;
    expiresIn: StringValue;
    refreshSecret: string;
    refreshExpiresIn: StringValue;
    helpdeskPrivateKey?: string;
};

export type TokenResponse = {
    accessToken: string;
    refreshToken: string;
};
