import { Injectable } from '@nestjs/common';
import {
    ISandboxProvider,
    SandboxInstance,
} from '@libs/code-review/domain/contracts/sandbox.provider';

@Injectable()
export class NullSandboxProvider implements ISandboxProvider {
    isAvailable(): boolean {
        return false;
    }

    async createSandboxWithRepo(): Promise<SandboxInstance> {
        throw new Error('No sandbox provider configured');
    }
}
