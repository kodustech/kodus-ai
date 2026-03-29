import { PlatformType } from '@libs/core/domain/enums';
import { RemoteCommands } from '../../infrastructure/adapters/services/collectCrossFileContexts.service';

export interface CreateSandboxParams {
    cloneUrl: string;
    authToken: string;
    /** Platform username for auth (required by Bitbucket App Passwords) */
    authUsername?: string;
    branch: string;
    prNumber?: number;
    platform: PlatformType;
}

export interface SandboxInstance {
    remoteCommands: RemoteCommands;
    cleanup: () => Promise<void>;
}

export interface ISandboxProvider {
    /** Whether this provider is configured and ready to use */
    isAvailable(): boolean;

    /** Create a sandbox with the repo cloned and ready */
    createSandboxWithRepo(
        params: CreateSandboxParams,
    ): Promise<SandboxInstance>;
}

export const SANDBOX_PROVIDER_TOKEN = Symbol('SANDBOX_PROVIDER_TOKEN');
