import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const SANDBOX_PREFIX = 'kodus-sandbox-';

/**
 * Check if a sandboxId refers to a local sandbox directory.
 * Returns true only for direct children of os.tmpdir() whose basename
 * starts with 'kodus-sandbox-'.
 */
export function isLocalSandboxPath(
    sandboxId: string | null | undefined,
): boolean {
    if (!sandboxId || typeof sandboxId !== 'string') return false;

    const tmpDir = os.tmpdir();
    const basename = path.basename(sandboxId);
    const resolved = path.resolve(tmpDir, basename);

    // Must be a direct child of tmpdir
    if (path.dirname(resolved) !== tmpDir) return false;
    // Must match the original path (prevents traversal)
    if (resolved !== sandboxId) return false;
    // Must have the right prefix
    return basename.startsWith(SANDBOX_PREFIX);
}

/**
 * Delete a local sandbox directory. Validates the path first.
 * Treats missing directories as success.
 */
export async function deleteLocalSandbox(sandboxId: string): Promise<void> {
    if (!isLocalSandboxPath(sandboxId)) {
        throw new Error(`Invalid local sandbox path: ${sandboxId}`);
    }

    try {
        await fs.access(sandboxId);
    } catch {
        // Directory already gone — success
        return;
    }

    await fs.rm(sandboxId, { recursive: true, force: true });
}
