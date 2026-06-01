import {
    CompleteCliAuthSession,
    CreateCliAuthSession,
    ICliAuthSession,
} from '../interfaces/cli-auth-session.interface';

export const CLI_AUTH_SESSION_REPOSITORY_TOKEN = Symbol(
    'CliAuthSessionRepository',
);

export interface ICliAuthSessionRepository {
    create(input: CreateCliAuthSession): Promise<ICliAuthSession>;
    findByState(state: string): Promise<ICliAuthSession | null>;
    findByDeviceCode(deviceCode: string): Promise<ICliAuthSession | null>;
    findByUserCode(userCode: string): Promise<ICliAuthSession | null>;
    complete(
        uuid: string,
        data: CompleteCliAuthSession,
    ): Promise<ICliAuthSession | null>;
    markConsumed(uuid: string): Promise<void>;
    markDenied(uuid: string): Promise<void>;
    expirePending(now: Date): Promise<number>;
}
