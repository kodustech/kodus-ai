import { Injectable } from '@nestjs/common';
import {
    ISandboxProvider,
    SandboxInstance,
} from '@libs/sandbox/domain/contracts/sandbox.provider';

@Injectable()
export class NullSandboxProvider implements ISandboxProvider {
    isAvailable(): boolean {
        return false;
    }

    async createSandboxWithRepo(): Promise<SandboxInstance> {
        throw new Error('No sandbox provider configured');
    }
}

const noSandbox = (operation: string): never => {
    throw new Error(
        `No sandbox configured: cannot ${operation}. There is no repository to look at, which is not the same as looking and finding nothing.`,
    );
};

/**
 * The stand-in handed out when no sandbox provider is configured.
 *
 * `grep`, `read` and `listDir` THROW (issue #1826). They used to resolve `''`
 * successfully, which made "I could not look" indistinguishable from "I looked
 * and found nothing" — so every consumer downstream read manufactured silence
 * as evidence about the repository. `readFile`/`writeFile` have always thrown;
 * these three are now consistent with them.
 *
 * Callers that legitimately run without a repository must gate on
 * `type === 'null'` (as `buildNativeToolConfigs` does) or catch, not rely on an
 * empty answer.
 */
export const NULL_SANDBOX_INSTANCE: SandboxInstance = {
    remoteCommands: {
        grep: async (pattern: string) =>
            noSandbox(`grep ${JSON.stringify(pattern)}`),
        read: async (path: string) => noSandbox(`read ${path}`),
        listDir: async (path: string) => noSandbox(`list ${path}`),
    },
    cleanup: async () => {},
    type: 'null',
    sandboxId: '',
    repoDir: '',
    run: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
    readFile: async () => { throw new Error('No sandbox configured'); },
    writeFile: async () => { throw new Error('No sandbox configured'); },
};
