import {
    CliAuthSessionMode,
    CliAuthSessionStatus,
} from '@libs/identity/infrastructure/adapters/repositories/schemas/cli-auth-session.model';

export interface ICliAuthSession {
    uuid: string;
    state: string;
    deviceCode?: string | null;
    userCode?: string | null;
    redirectUri?: string | null;
    mode: CliAuthSessionMode;
    status: CliAuthSessionStatus;
    accessToken?: string | null;
    refreshToken?: string | null;
    userId?: string | null;
    userEmail?: string | null;
    userAgent?: string | null;
    expiresAt: Date;
    consumedAt?: Date | null;
    completedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export type CreateCliAuthSession = Pick<
    ICliAuthSession,
    | 'state'
    | 'mode'
    | 'expiresAt'
    | 'redirectUri'
    | 'deviceCode'
    | 'userCode'
    | 'userAgent'
>;

export type CompleteCliAuthSession = Pick<
    ICliAuthSession,
    'accessToken' | 'refreshToken' | 'userId' | 'userEmail'
>;

export { CliAuthSessionMode, CliAuthSessionStatus };
