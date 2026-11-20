import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';
import { createLogger } from '@libs/core/log/logger';
import type { SandboxRef } from '@libs/runtime/contracts/sandbox';
import {
    SANDBOX_FILE_CHUNK_BYTES,
    type SandboxOp,
    type SandboxResult,
} from '@libs/runtime/protocol/sandbox';
import {
    CreateSandboxParams,
    ISandboxProvider,
    SandboxInstance,
    SandboxRunOptions,
    SandboxRunResult,
    toBranchName,
} from '@libs/sandbox/domain/contracts/sandbox.provider';
import { resolvePrRefspec } from '@libs/sandbox/infrastructure/providers/e2b-sandbox.service';
import { buildGitAuthHeader } from '@libs/sandbox/infrastructure/providers/git-auth-header';
import { sedLineRange } from '@libs/sandbox/infrastructure/providers/read-within-root';
import {
    fetchSubmodules,
    isContainedRelativePath,
    type SubmoduleGitHost,
} from '@libs/sandbox/infrastructure/providers/submodule-fetch';
import {
    runtimeSandboxId,
    setRuntimeSandboxReleaser,
} from '@libs/sandbox/infrastructure/services/immediate-sandbox-cleanup';

import {
    RuntimeSandboxClient,
    RuntimeSandboxError,
} from './runtime-sandbox.client';

// The runtime-sandbox provider (docs/runtime/sandbox.md): a code sandbox on a
// Kody Runtime cell, one tool machine under gVisor with the guest agent
// inside, reached through the runtime-worker and the hub. Kodus Cloud and
// self-hosted run it the same way, with no third-party key.
//
// The review's behaviours are the E2B provider's, over the same primitives:
// the checkout is a shallow git fetch inside the sandbox with the auth header
// in that command's env only (never in its text), the base branch and the
// submodules are fetched by the shared code, reads never follow a symlink or
// leave the root (the guest agent opens every path segment with O_NOFOLLOW),
// and the review user has no way to become root (no-new-privileges, no
// capability, no set-id file: privilegesDropped is checked, not assumed).

/** The guest agent's root; every file op is relative to it. */
const ROOT = '/workspace';
const REPO_DIR = `${ROOT}/repo`;
const LINKED_DIR = `${ROOT}/_linked`;
// The provider's own commands name these relative to the guest agent's root,
// where every command starts: the same on every driver, whatever the root's
// path on the machine (the fake driver's is a directory of the host).
const REPO = 'repo';
/** Where a command's output goes when it is too large for one answer. */
const SPILL = '.kody-run';

const TIMEOUTS = {
    CLONE_MS: 300_000,
    SUBMODULES_MS: 120_000,
    COMMAND_LONG_MS: 30_000,
    COMMAND_SHORT_MS: 10_000,
    PRIVILEGES_MS: 30_000,
};
/** What run() returns of a stream at most (the local provider's cap). */
const MAX_RUN_OUTPUT = 5 * 1024 * 1024;
/** Inline answers up to these sizes; above, the output is read back from the spill files. */
const INLINE_STDOUT = 180_000;
const INLINE_STDERR = 30_000;
/** readFile reads at most this much (graph files are the largest readers). */
const MAX_READ_FILE = 64 * 1024 * 1024;
/** How often a live sandbox's lease is renewed (its lease is 30 minutes). */
const RENEW_EVERY_MS = 10 * 60_000;

const SPILL_MARKER = 'KODY-RUNTIME-SANDBOX-SPILLED';

/** The git host a clone URL fetches from: the one host the sandbox needs on top of the org's. */
export function cloneHost(cloneUrl: string): string | undefined {
    try {
        const h = new URL(cloneUrl).hostname.toLowerCase();
        return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
            h,
        )
            ? h
            : undefined;
    } catch {
        return undefined;
    }
}

/** An absolute sandbox path, or one relative to the root, as the guest agent's root-relative path. */
export function toGuestPath(path: string): string {
    const rel = path.startsWith(`${ROOT}/`)
        ? path.slice(ROOT.length + 1)
        : path;
    if (
        rel.startsWith('/') ||
        rel === '' ||
        rel.split('/').some((s) => s === '' || s === '.' || s === '..')
    ) {
        throw new Error(`Path is outside the sandbox root ${ROOT}: ${path}`);
    }
    return rel;
}

/** Lines start..end (1-based, inclusive; start < 1 is 1) of text, as sed prints them; 0,0 is the whole file. */
export function lineRange(text: string, start: number, end: number): string {
    sedLineRange(start, end); // the same refusal as the other providers for a bad range
    if (start === 0 && end === 0) return text;
    const finalNewline = text.endsWith('\n');
    const lines = text.split('\n');
    if (finalNewline) lines.pop();
    const from = Math.max(start, 1) - 1;
    const picked = lines.slice(from, end);
    if (!picked.length) return '';
    // sed ends every line it prints with a newline, the file's last one only when the file did.
    const last = from + picked.length >= lines.length;
    return picked.join('\n') + (!last || finalNewline ? '\n' : '');
}

function check(r: SandboxResult, what: string): SandboxResult {
    if (!r.ok)
        throw new Error(
            `${what}: ${r.error?.message ?? r.error?.code ?? 'refused'}`,
        );
    return r;
}

/** One live sandbox on a cell: its ops, and what the review sees of it. */
class RuntimeSandbox {
    constructor(
        private readonly client: RuntimeSandboxClient,
        readonly ref: SandboxRef,
    ) {}

    op(op: SandboxOp): Promise<SandboxResult> {
        return this.client.op(this.ref, randomUUID(), op);
    }

    /** The whole of a file (bounded), in chunks. */
    async readBytes(
        path: string,
        max = MAX_READ_FILE,
    ): Promise<{ data: Buffer; truncated: boolean }> {
        const parts: Buffer[] = [];
        let offset = 0;
        for (;;) {
            const r = check(
                await this.op({
                    op: 'read',
                    path,
                    offset,
                    length: SANDBOX_FILE_CHUNK_BYTES,
                }),
                `read ${path}`,
            );
            const chunk = Buffer.from(r.content ?? '', 'base64');
            parts.push(chunk);
            offset += chunk.length;
            if (r.eof || chunk.length === 0)
                return { data: Buffer.concat(parts), truncated: false };
            if (offset >= max)
                return {
                    data: Buffer.concat(parts).subarray(0, max),
                    truncated: true,
                };
        }
    }

    async writeBytes(path: string, data: Buffer): Promise<void> {
        let offset = 0;
        do {
            const chunk = data.subarray(
                offset,
                offset + SANDBOX_FILE_CHUNK_BYTES,
            );
            check(
                await this.op({
                    op: 'write',
                    path,
                    content: chunk.toString('base64'),
                    mkdirs: true,
                    ...(offset > 0 ? { append: true } : {}),
                }),
                `write ${path}`,
            );
            offset += chunk.length;
        } while (offset < data.length);
    }

    /**
     * A shell command, its output whole up to MAX_RUN_OUTPUT: a small one
     * comes back in the answer; a large one is written to two files under
     * SPILL_DIR, read back in chunks and removed.
     */
    async run(
        command: string,
        opts?: SandboxRunOptions,
    ): Promise<SandboxRunResult> {
        if (opts?.asRoot) {
            throw new Error(
                'The runtime sandbox runs no command as root: its user has no root path at all',
            );
        }
        const id = randomUUID();
        const out = `${SPILL}/${id}.out`;
        const err = `${SPILL}/${id}.err`;
        // The notice carries this call's id: a command whose own output is the
        // bare marker (a grep over this very code) is never read as spilled.
        const spilled = `${SPILL_MARKER}:${id}`;
        const wrapped = [
            `mkdir -p ${SPILL}`,
            `{ ( ${command}\n) > ${out} 2> ${err}; c=$?; }`,
            `if [ "$(wc -c < ${out})" -le ${INLINE_STDOUT} ] && [ "$(wc -c < ${err})" -le ${INLINE_STDERR} ]; then cat ${out}; cat ${err} >&2; rm -f ${out} ${err}; else echo ${spilled}; fi`,
            'exit $c',
        ].join('; ');
        const r = check(
            await this.op({
                op: 'exec',
                command: wrapped,
                timeoutMs: opts?.timeoutMs ?? TIMEOUTS.COMMAND_LONG_MS,
                ...(opts?.envs && Object.keys(opts.envs).length
                    ? { env: opts.envs }
                    : {}),
            }),
            'exec',
        );
        const e = r.exec!;
        if (e.stdout.trim() !== spilled) {
            return {
                stdout: e.stdout,
                stderr: e.stderr,
                exitCode: e.timedOut ? 124 : e.exitCode,
            };
        }
        const read = async (p: string) => {
            const { data, truncated } = await this.readBytes(p, MAX_RUN_OUTPUT);
            return (
                data.toString('utf8') +
                (truncated ? '\n[output truncated]' : '')
            );
        };
        try {
            return {
                stdout: await read(out),
                stderr: await read(err),
                exitCode: e.timedOut ? 124 : e.exitCode,
            };
        } finally {
            await Promise.all(
                [out, err].map((p) =>
                    this.op({ op: 'remove', path: p }).catch(() => undefined),
                ),
            );
        }
    }

    remoteCommands(): RemoteCommands {
        const resolveRepoPath = (path: string) => {
            if (path.startsWith('/'))
                throw new Error('Absolute paths are not allowed');
            if (path.includes('..'))
                throw new Error('Path traversal using ".." is not allowed');
            return path;
        };
        const readRoot = (root?: string) => {
            if (root === undefined || root === REPO_DIR) return 'repo';
            if (
                root.startsWith(`${LINKED_DIR}/`) &&
                !root.includes('..') &&
                root.length > LINKED_DIR.length + 1
            )
                return toGuestPath(root);
            throw new Error(`Not a repository root of this sandbox: ${root}`);
        };
        const q = (s: string) => s.replace(/'/g, "'\\''");
        return {
            grep: async (pattern, path, glob) => {
                resolveRepoPath(path);
                const globArg = glob ? ` --glob '${q(glob)}'` : '';
                const r = await this.run(
                    `cd ${REPO} && rg --no-heading -n${globArg} -e '${q(pattern)}' -- '${q(path)}'`,
                    { timeoutMs: TIMEOUTS.COMMAND_LONG_MS },
                );
                if (!r.stdout && r.exitCode >= 2 && r.stderr)
                    return `Error: ${r.stderr}`;
                return r.stdout || 'No matches found.';
            },
            // Through the guest agent's file op: no symlink anywhere on the
            // path is followed and nothing outside the root is reached.
            read: async (path, start, end, root) => {
                const rel = `${readRoot(root)}/${resolveRepoPath(path)}`;
                sedLineRange(start, end);
                const { data } = await this.readBytes(rel);
                return lineRange(data.toString('utf8'), start, end);
            },
            listDir: async (path, maxDepth) => {
                resolveRepoPath(path);
                const p = q(path.startsWith('-') ? `./${path}` : path);
                const r = await this.run(
                    `cd ${REPO} && [ -e '${p}' ] && find '${p}' -maxdepth ${Number(maxDepth) | 0} -type f`,
                    { timeoutMs: TIMEOUTS.COMMAND_LONG_MS },
                );
                if (!r.stdout && r.stderr) return `Error: ${r.stderr}`;
                return r.stdout;
            },
            exec: async (command) => {
                const r = await this.run(`cd ${REPO} && ${command}`, {
                    timeoutMs: TIMEOUTS.COMMAND_LONG_MS,
                });
                return {
                    stdout: r.stdout,
                    stderr: r.stderr || '',
                    exitCode: r.exitCode,
                };
            },
        };
    }
}

@Injectable()
export class RuntimeSandboxService implements ISandboxProvider {
    private readonly logger = createLogger(RuntimeSandboxService.name);
    private readonly client: RuntimeSandboxClient;
    /**
     * Each live sandbox's lease renewal, by sandbox id. Whoever ends the
     * sandbox stops it: its own cleanup, or the lease manager and its reaper
     * through the releaser (they replace cleanup with their own release).
     */
    private readonly renewals = new Map<string, ReturnType<typeof setInterval>>();

    constructor(configService: ConfigService, client?: RuntimeSandboxClient) {
        this.client =
            client ??
            new RuntimeSandboxClient({
                baseUrl:
                    configService.get<string>('RUNTIME_SANDBOX_URL') ||
                    configService.get<string>('RUNTIME_ENV_SESSION_URL'),
                secretSealKey: configService.get<string>(
                    'RUNTIME_SECRET_SEAL_KEY',
                ),
            });
        // The lease manager and its reaper end a runtime sandbox through this provider.
        setRuntimeSandboxReleaser((ref) => {
            this.stopRenewing(ref.sandboxId);
            return this.client.release(ref);
        });
    }

    isAvailable(): boolean {
        return this.client.configured;
    }

    async createSandboxWithRepo(
        params: CreateSandboxParams,
    ): Promise<SandboxInstance> {
        const organizationId = params.organizationId;
        if (!organizationId)
            throw new Error(
                'A runtime sandbox belongs to an organization: createSandboxWithRepo needs organizationId',
            );
        const ref: SandboxRef = { organizationId, sandboxId: randomUUID() };
        const host = cloneHost(params.cloneUrl);
        const started = Date.now();
        const view = await this.client.open({
            ...ref,
            ...(host ? { egressAllow: [host] } : {}),
        });
        if (view.state !== 'ready') {
            const why =
                (view.blockers ?? [])
                    .map((b) => `${b.signature}: ${b.message}`)
                    .join('; ') || 'blocked';
            throw new RuntimeSandboxError(
                409,
                view.blockers?.[0]?.signature ?? 'blocked',
                `The runtime sandbox did not start: ${why}`,
            );
        }
        const sandbox = new RuntimeSandbox(this.client, ref);
        const release = () =>
            this.client
                .release(ref)
                .catch((error) =>
                    this.logger.warn({
                        message: 'Failed to release the runtime sandbox',
                        context: RuntimeSandboxService.name,
                        error,
                        metadata: { sandboxId: ref.sandboxId },
                    }),
                );
        const renew = setInterval(() => {
            this.client.renew(ref).catch((error) => {
                // The cell no longer has it (released elsewhere, or expired): nothing left to renew.
                if (
                    error instanceof RuntimeSandboxError &&
                    (error.status === 404 ||
                        error.status === 410 ||
                        error.code === 'lease_expired')
                ) {
                    this.stopRenewing(ref.sandboxId);
                    return;
                }
                this.logger.warn({
                    message: 'Failed to renew the runtime sandbox lease',
                    context: RuntimeSandboxService.name,
                    error,
                    metadata: { sandboxId: ref.sandboxId },
                });
            });
        }, RENEW_EVERY_MS);
        renew.unref?.();
        this.renewals.set(ref.sandboxId, renew);
        try {
            const privilegesDropped = await this.privilegesDropped(sandbox);
            const authHeader = params.authToken
                ? buildGitAuthHeader(
                      params.platform,
                      params.authToken,
                      params.authUsername,
                  )
                : undefined;
            await this.clone(sandbox, params, authHeader);
            if (params.unifiedDiff && params.checkoutSha)
                await this.applyLocalDiff(sandbox, params.unifiedDiff);
            const baseBranch = await this.fetchBaseBranch(
                sandbox,
                params,
                authHeader,
            );
            await this.fetchSubmodules(sandbox, params, authHeader, baseBranch);
            // The checkout is complete, and the git host is the only network
            // the sandbox needed. From here it runs attacker-controlled PR
            // code and model-chosen commands, so its egress is closed for
            // good (the git host, the cell's lists and its mirror included).
            // Fail closed: a seal that did not happen throws, the catch below
            // releases the sandbox, and the review runs without one.
            await this.client.seal(ref);
            this.logger.log({
                message: `Runtime sandbox ready for PR#${params.prNumber ?? '?'} in ${Date.now() - started} ms`,
                context: RuntimeSandboxService.name,
                metadata: {
                    sandboxId: ref.sandboxId,
                    cellId: view.cellId,
                    ms: Date.now() - started,
                },
            });
            return {
                remoteCommands: sandbox.remoteCommands(),
                cleanup: async () => {
                    this.stopRenewing(ref.sandboxId);
                    await release();
                },
                type: 'runtime',
                sandboxId: runtimeSandboxId(organizationId, ref.sandboxId),
                baseBranch,
                repoDir: REPO_DIR,
                privilegesDropped,
                run: (command, opts) => sandbox.run(command, opts),
                readFile: async (path) =>
                    (await sandbox.readBytes(toGuestPath(path))).data.toString(
                        'utf8',
                    ),
                writeFile: (path, content) =>
                    sandbox.writeBytes(
                        toGuestPath(path),
                        Buffer.from(content, 'utf8'),
                    ),
            };
        } catch (error) {
            this.stopRenewing(ref.sandboxId);
            await release();
            throw error;
        }
    }

    private stopRenewing(sandboxId: string): void {
        const timer = this.renewals.get(sandboxId);
        if (timer === undefined) return;
        clearInterval(timer);
        this.renewals.delete(sandboxId);
    }

    /**
     * Whether the review user has no way to become root: not root, no new
     * privileges, no set-id file on the system trees. The machine is built
     * that way; this checks it before anything with credentials may trust it.
     */
    private async privilegesDropped(sandbox: RuntimeSandbox): Promise<boolean> {
        const r = await sandbox
            .run(
                `[ "$(id -u)" != 0 ] && grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status && [ -z "$(find /bin /sbin /usr /lib /etc /opt -xdev -type f -perm /6000 2>/dev/null | head -n 1)" ] && echo KODUS_REVIEW_USER_UNPRIVILEGED`,
                { timeoutMs: TIMEOUTS.PRIVILEGES_MS },
            )
            .catch(() => ({ exitCode: -1, stdout: '' }));
        return (
            r.exitCode === 0 &&
            r.stdout.trim() === 'KODUS_REVIEW_USER_UNPRIVILEGED'
        );
    }

    private async clone(
        sandbox: RuntimeSandbox,
        params: CreateSandboxParams,
        authHeader?: string,
    ): Promise<void> {
        const { cloneUrl, branch, prNumber, platform, checkoutSha } = params;
        const refspec =
            checkoutSha != null
                ? checkoutSha
                : prNumber != null
                  ? resolvePrRefspec(platform, prNumber, cloneUrl, branch)
                  : `refs/heads/${branch}`;
        const localRef =
            checkoutSha != null
                ? 'cli-base'
                : prNumber != null
                  ? 'pr-head'
                  : 'cli-head';
        const url = shSingleQuote(cloneUrl);
        const fetch = authHeader
            ? `git -c http.extraHeader="$GIT_AUTH_HEADER" fetch --depth=1 ${url} ${shSingleQuote(refspec)}:${shSingleQuote(localRef)}`
            : `git fetch --depth=1 ${url} ${shSingleQuote(refspec)}:${shSingleQuote(localRef)}`;
        const r = await sandbox.run(
            [
                `git init -q ${REPO}`,
                `cd ${REPO}`,
                fetch,
                `git checkout -q ${shSingleQuote(localRef)}`,
                `git remote add origin ${url}`,
                'git remote set-url --push origin no-push-allowed',
            ].join(' && '),
            {
                timeoutMs: TIMEOUTS.CLONE_MS,
                ...(authHeader
                    ? { envs: { GIT_AUTH_HEADER: authHeader } }
                    : {}),
            },
        );
        if (r.exitCode !== 0) {
            throw new Error(
                `Git clone failed in the runtime sandbox (exit code ${r.exitCode}): ${r.stderr || r.stdout}`.slice(
                    0,
                    500,
                ),
            );
        }
    }

    /** Same as the E2B provider: a failed apply leaves the merge-base, never fails the review. */
    private async applyLocalDiff(
        sandbox: RuntimeSandbox,
        unifiedDiff: string,
    ): Promise<void> {
        const patch = '.kody-cli.patch';
        try {
            await sandbox.writeBytes(patch, Buffer.from(unifiedDiff, 'utf8'));
            const r = await sandbox.run(
                `cd ${REPO} && git config user.email kodus-cli@kodus.local && git config user.name 'Kodus CLI' && git apply --3way --whitespace=nowarn ../${patch}`,
            );
            if (r.exitCode !== 0)
                await sandbox.run(
                    `cd ${REPO} && git apply --whitespace=fix --reject ../${patch} || true`,
                );
        } catch (error) {
            this.logger.warn({
                message:
                    'CLI diff not applied in the runtime sandbox; the agent reviews the merge-base',
                context: RuntimeSandboxService.name,
                error,
            });
        }
    }

    private async fetchBaseBranch(
        sandbox: RuntimeSandbox,
        params: CreateSandboxParams,
        authHeader?: string,
    ): Promise<string | undefined> {
        const base = toBranchName(params.baseBranch);
        if (!base) return undefined;
        const b = shSingleQuote(base);
        const url = shSingleQuote(params.cloneUrl);
        const cmd = authHeader
            ? `cd ${REPO} && git -c http.extraHeader="$GIT_AUTH_HEADER" fetch --depth=1 ${url} refs/heads/${b}:refs/remotes/origin/${b}`
            : `cd ${REPO} && git fetch --depth=1 ${url} refs/heads/${b}:refs/remotes/origin/${b}`;
        const r = await sandbox
            .run(cmd, {
                timeoutMs: TIMEOUTS.CLONE_MS,
                ...(authHeader
                    ? { envs: { GIT_AUTH_HEADER: authHeader } }
                    : {}),
            })
            .catch(() => ({ exitCode: -1, stderr: '', stdout: '' }));
        return r.exitCode === 0 ? base : undefined;
    }

    private async fetchSubmodules(
        sandbox: RuntimeSandbox,
        params: CreateSandboxParams,
        authHeader: string | undefined,
        baseBranch?: string,
    ): Promise<void> {
        const host: SubmoduleGitHost = {
            readGitmodules: async () => {
                try {
                    return (
                        await sandbox.readBytes('repo/.gitmodules')
                    ).data.toString('utf8');
                } catch {
                    return null;
                }
            },
            git: async (args, opts) => {
                const r = await sandbox.run(
                    `cd ${REPO} && git ${args.map((a) => shSingleQuote(a)).join(' ')}`,
                    {
                        timeoutMs: opts?.timeoutMs ?? TIMEOUTS.COMMAND_SHORT_MS,
                        ...(opts?.env ? { envs: opts.env } : {}),
                    },
                );
                if (r.exitCode !== 0)
                    throw new Error(
                        `git ${args[0]} failed (exit ${r.exitCode}): ${(r.stderr ?? '').slice(0, 300)}`,
                    );
                return { stdout: r.stdout };
            },
            removeDir: async (relative) => {
                if (!isContainedRelativePath(relative))
                    throw new Error(
                        `refusing to remove a path outside the checkout: ${relative}`,
                    );
                await sandbox.run(
                    `rm -rf ${shSingleQuote(`${REPO}/${relative}`)}`,
                    { timeoutMs: TIMEOUTS.COMMAND_SHORT_MS },
                );
            },
        };
        await fetchSubmodules(host, {
            repoCloneUrl: params.cloneUrl,
            baseRef: baseBranch ? `origin/${baseBranch}` : undefined,
            authHeader,
            totalBudgetMs: TIMEOUTS.SUBMODULES_MS,
            stepTimeoutMs: TIMEOUTS.COMMAND_LONG_MS,
            logger: this.logger,
            logContext: RuntimeSandboxService.name,
            logMetadata: { prNumber: params.prNumber },
        });
    }
}
