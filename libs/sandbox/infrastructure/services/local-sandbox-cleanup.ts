import { lstat, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, resolve } from 'path';

const LOCAL_SANDBOX_PREFIX = 'kodus-sandbox-';

export function isLocalSandboxPath(sandboxId?: string): boolean {
    if (!sandboxId || !isAbsolute(sandboxId)) {
        return false;
    }

    const tmpRoot = resolve(tmpdir());
    const candidate = resolve(sandboxId);

    return (
        dirname(candidate) === tmpRoot &&
        basename(candidate).startsWith(LOCAL_SANDBOX_PREFIX)
    );
}

export async function cleanupLocalSandboxDirectory(
    sandboxId?: string,
): Promise<boolean> {
    if (!isLocalSandboxPath(sandboxId)) {
        return false;
    }

    const resolved = resolve(sandboxId!);
    if (!(await localSandboxDirectoryExists(resolved))) {
        return false;
    }

    await rm(resolved, { recursive: true, force: true });
    return true;
}

export async function localSandboxDirectoryExists(
    sandboxId?: string,
): Promise<boolean> {
    if (!isLocalSandboxPath(sandboxId)) {
        return false;
    }

    try {
        await lstat(resolve(sandboxId!));
        return true;
    } catch (error: any) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}
