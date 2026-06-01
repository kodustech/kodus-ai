import { PlatformType } from '@libs/core/domain/enums';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

export interface CreateSandboxParams {
    cloneUrl: string;
    authToken: string;
    branch: string;
    platform: PlatformType;
    /** Platform username for auth (required by Bitbucket App Passwords) */
    authUsername?: string;
    prNumber?: number;
    /** Base branch of the PR (e.g. "main", "develop"). Used to fetch the base ref so git diff works in the sandbox. */
    baseBranch?: string;
    /**
     * CLI-only: SHA to checkout instead of fetching `refs/heads/<branch>`.
     * Set to the user's local merge-base when the branch hasn't been pushed
     * yet. After the SHA is checked out, `unifiedDiff` (if any) is applied
     * on top, recreating the user's local working state on the remote-known
     * base. Falsy → fall back to legacy clone-by-branch.
     */
    checkoutSha?: string;
    /**
     * CLI-only: unified diff to `git apply --3way` on top of `checkoutSha`
     * after clone. Recreates branches that aren't pushed and uncommitted
     * working-tree changes inside the sandbox.
     */
    unifiedDiff?: string;
    /** Arbitrary key-value tags forwarded to the sandbox provider (e.g. E2B metadata for filtering/monitoring). */
    sandboxMetadata?: Record<string, string>;
}

export interface SandboxRunResult {
    stdout: string;
    stderr?: string;
    exitCode: number;
}

export interface SandboxInstance {
    remoteCommands: RemoteCommands;
    cleanup: () => Promise<void>;
    /** Which sandbox provider created this instance */
    type: 'e2b' | 'local' | 'null';
    /**
     * Stable identifier the lease manager persists on the lease doc so a
     * second consumer can warm-resume by reconnecting via the provider.
     * For e2b this is the E2B sandboxId; for local it is a generated id;
     * for null it is the empty string (marker for "no real sandbox").
     */
    sandboxId: string;
    /** Base branch fetched in the sandbox (e.g. "main"). Allows tools to run git diff origin/${baseBranch}...HEAD */
    baseBranch?: string;
    /** Absolute path to the repo root inside the sandbox */
    repoDir: string;
    /** Run a shell command inside the sandbox */
    run(command: string, opts?: { timeoutMs?: number }): Promise<SandboxRunResult>;
    /** Read a file from the sandbox filesystem */
    readFile(path: string, opts?: { timeoutMs?: number }): Promise<string>;
    /** Write a file to the sandbox filesystem */
    writeFile(path: string, content: string, opts?: { timeoutMs?: number }): Promise<void>;
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
