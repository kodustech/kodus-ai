export type JWT = {
    secret: string;
    expiresIn: string;
    refreshSecret: string;
    refreshExpiresIn: string;
};

export type TokenResponse = {
    accessToken: string;
    refreshToken: string;
};
