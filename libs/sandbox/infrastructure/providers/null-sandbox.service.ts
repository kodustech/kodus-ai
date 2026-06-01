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

export const NULL_SANDBOX_INSTANCE: SandboxInstance = {
    remoteCommands: {
        grep: async () => '',
        read: async () => '',
        listDir: async () => '',
    },
    cleanup: async () => {},
    type: 'null',
    sandboxId: '',
    repoDir: '',
    run: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
    readFile: async () => { throw new Error('No sandbox configured'); },
    writeFile: async () => { throw new Error('No sandbox configured'); },
};
