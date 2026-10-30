import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendRecordLine } from '../services/trace/session-store.js';
import { TRACE_BRANCH } from '../services/trace/decision-branch.service.js';

const exec = promisify(execFile);

/**
 * End-to-end against the real CLI binary and real git: the commit trailer, the
 * pre-push hook, and the no-agent-CLI path.
 */

let cliEntryPoint: string;
let binDir: string;
let traceHome: string;
let originDir: string;
let repoRoot: string;

const GIT_IDENTITY = {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.invalid',
};

/**
 * A PATH containing git and the `kodus` shim — and deliberately no agent CLI,
 * so `claude`, `codex`, `gemini` and `cursor-agent` are all absent.
 */
function hookEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
        PATH: binDir,
        KODUS_TRACE_HOME: traceHome,
        NO_UPDATE_NOTIFIER: '1',
        NODE_OPTIONS: '',
        ...GIT_IDENTITY,
        ...extra,
    };
}

async function waitFor(
    predicate: () => Promise<boolean>,
    timeoutMs = 20_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function installFakeAgent(): Promise<{
    command: string;
    logPath: string;
}> {
    const agentPath = path.join(binDir, `trace-agent-${Date.now()}`);
    const logPath = path.join(traceHome, 'agent-calls.log');
    await fs.writeFile(
        agentPath,
        [
            '#!/bin/sh',
            'INPUT="$(cat)"',
            'printf \'call\\n\' >> "$KODUS_AGENT_LOG"',
            'case "$INPUT" in',
            '  *"Summarize one commit"*) printf \'%s\\n\' \'{"summary":"summary","points":["point"]}\' ;;',
            '  *) printf \'%s\\n\' \'{"decisions":[{"type":"convention","decision":"keep the pushed behavior","confidence":0.9,"scope":["src/pushed.ts"]}]}\' ;;',
            'esac',
            '',
        ].join('\n'),
        { mode: 0o755 },
    );
    return { command: agentPath, logPath };
}

async function agentCallCount(logPath: string): Promise<number> {
    return fs
        .readFile(logPath, 'utf-8')
        .then((value) => value.split('\n').filter(Boolean).length)
        .catch(() => 0);
}

async function git(
    cwd: string,
    args: string[],
    extraEnv: Record<string, string> = {},
): Promise<string> {
    const { stdout } = await exec('git', args, {
        cwd,
        env: hookEnv(extraEnv),
    });
    return stdout;
}

async function commitFile(
    cwd: string,
    filePath: string,
    content: string,
    message: string,
): Promise<void> {
    const absolute = path.join(cwd, filePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf-8');
    await git(cwd, ['add', filePath]);
    await git(cwd, ['commit', '-m', message]);
}

async function runCli(
    cwd: string,
    args: string[],
    extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
        const { stdout, stderr } = await exec(
            process.execPath,
            [cliEntryPoint, ...args],
            { cwd, env: hookEnv(extraEnv) },
        );
        return { stdout, stderr, code: 0 };
    } catch (error) {
        const err = error as {
            stdout?: string;
            stderr?: string;
            code?: number;
        };
        return {
            stdout: err.stdout ?? '',
            stderr: err.stderr ?? '',
            code: err.code ?? 1,
        };
    }
}

async function seedSession(
    repo: string,
    sessionId: string,
    branch: string,
): Promise<void> {
    await appendRecordLine(repo, sessionId, {
        kind: 'session-start',
        sessionId,
        agentType: 'claude-code',
        branch,
        baseCommit: 'abc',
        gitRemote: '',
        cliVersion: '0.0.0',
        timestamp: new Date().toISOString(),
    });
}

describe('Trace git E2E', { timeout: 120_000 }, () => {
    beforeAll(async () => {
        const cliRoot = path.resolve(
            import.meta.dirname ??
                path.dirname(new URL(import.meta.url).pathname),
            '..',
            '..',
        );
        cliEntryPoint = path.join(cliRoot, 'dist', 'index.js');
        await fs.access(cliEntryPoint);

        binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-bin-'));

        // Only the tools the hooks legitimately need. No agent CLI.
        for (const tool of [
            'git',
            'sh',
            'which',
            'grep',
            'cat',
            'env',
            'uname',
            'sleep',
        ]) {
            const resolved = await exec('which', [tool])
                .then(({ stdout }) => stdout.trim())
                .catch(() => '');
            if (resolved) {
                await fs.symlink(resolved, path.join(binDir, tool));
            }
        }

        const kodusShim = path.join(binDir, 'kodus');
        await fs.writeFile(
            kodusShim,
            `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliEntryPoint)} "$@"\n`,
            { mode: 0o755 },
        );
    });

    afterAll(async () => {
        await fs.rm(binDir, { recursive: true, force: true }).catch(() => {});
    });

    beforeEach(async () => {
        traceHome = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-e2e-home-'));
        // The test process seeds the store directly, so it needs the same
        // KODUS_TRACE_HOME the spawned CLI gets.
        process.env.KODUS_TRACE_HOME = traceHome;
        originDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'trace-e2e-origin-'),
        );
        // `git rev-parse --show-toplevel` resolves symlinks (on macOS the temp
        // dir is behind /private), and the store is keyed by the git root — so
        // the test has to seed under the same resolved path the CLI will see.
        repoRoot = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), 'trace-e2e-repo-')),
        );

        await git(originDir, ['init', '--bare', '--initial-branch=main']);
        await git(repoRoot, ['init', '--initial-branch=main']);
        await git(repoRoot, ['remote', 'add', 'origin', originDir]);
        await commitFile(repoRoot, 'README.md', '# repo\n', 'initial');
        await git(repoRoot, ['push', '-q', 'origin', 'main']);
    });

    it('adds a Kodus-Trace trailer that survives a rebase', async () => {
        const enable = await runCli(repoRoot, [
            'trace',
            'enable',
            '--agents',
            'claude',
        ]);
        expect(enable.code).toBe(0);

        await git(repoRoot, ['checkout', '-q', '-b', 'feat/trailer']);
        await seedSession(repoRoot, 'sess-trailer-001', 'feat/trailer');

        await commitFile(repoRoot, 'src/a.ts', 'a\n', 'feat: a');

        const message = await git(repoRoot, ['log', '-1', '--format=%B']);
        expect(message).toContain('Kodus-Trace: sess-trailer');
        expect(
            (
                await git(repoRoot, [
                    'log',
                    '-1',
                    '--format=%(trailers:key=Kodus-Trace,valueonly)',
                ])
            ).trim(),
        ).toBe('sess-trailer');

        // Move main forward, then rebase the feature branch onto it.
        await git(repoRoot, ['checkout', '-q', 'main']);
        await commitFile(repoRoot, 'other.ts', 'x\n', 'chore: other');
        await git(repoRoot, ['checkout', '-q', 'feat/trailer']);
        await git(repoRoot, ['rebase', 'main']);

        const rebased = await git(repoRoot, ['log', '-1', '--format=%B']);
        expect(rebased).toContain('Kodus-Trace: sess-trailer');
    });

    it('does not add a second trailer when the message already has one', async () => {
        await runCli(repoRoot, ['trace', 'enable', '--agents', 'claude']);
        await git(repoRoot, ['checkout', '-q', '-b', 'feat/once']);
        await seedSession(repoRoot, 'sess-once-0001', 'feat/once');

        await fs.writeFile(path.join(repoRoot, 'src.ts'), 'a\n');
        await git(repoRoot, ['add', 'src.ts']);
        await git(repoRoot, [
            'commit',
            '-m',
            'feat: with trailer\n\nKodus-Trace: preset-0000',
        ]);

        const message = await git(repoRoot, ['log', '-1', '--format=%B']);
        expect(message.match(/Kodus-Trace:/g)).toHaveLength(1);
        expect(message).toContain('preset-0000');
    });

    it('adds no trailer when nothing was captured', async () => {
        await runCli(repoRoot, ['trace', 'enable', '--agents', 'claude']);
        await commitFile(repoRoot, 'src/b.ts', 'b\n', 'feat: b');

        const message = await git(repoRoot, ['log', '-1', '--format=%B']);
        expect(message).not.toContain('Kodus-Trace');
    });

    it('does not link a commit to a session captured on another branch', async () => {
        await runCli(repoRoot, ['trace', 'enable', '--agents', 'claude']);
        await seedSession(repoRoot, 'sess-other-0001', 'feature/other');
        await commitFile(repoRoot, 'src/branch.ts', 'main\n', 'feat: main');

        const message = await git(repoRoot, ['log', '-1', '--format=%B']);
        expect(message).not.toContain('Kodus-Trace');
    });

    it('runs distillation from pre-push without the push waiting on it', async () => {
        await runCli(repoRoot, ['trace', 'enable', '--agents', 'claude']);
        await git(repoRoot, ['checkout', '-q', '-b', 'feat/push']);
        await commitFile(repoRoot, 'src/c.ts', 'c\n', 'feat: c');

        const startedAt = Date.now();
        // A "model" that takes 30 seconds. The push must not wait for it.
        await git(repoRoot, ['push', '-q', 'origin', 'feat/push'], {
            KODUS_TRACE_AGENT_CMD: 'sleep 30',
        });
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThan(20_000);
        expect(
            (await git(repoRoot, ['rev-parse', 'origin/feat/push'])).trim(),
        ).toBe((await git(repoRoot, ['rev-parse', 'HEAD'])).trim());
    });

    it('distills a non-checked-out branch at the exact pushed commit and does not recurse', async () => {
        await runCli(repoRoot, ['trace', 'enable', '--agents', 'claude']);
        const agent = await installFakeAgent();

        await git(repoRoot, ['checkout', '-q', '-b', 'feature-x']);
        await commitFile(
            repoRoot,
            'src/pushed.ts',
            'feature\n',
            'feat: pushed',
        );
        const pushedHead = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
        await git(repoRoot, ['checkout', '-q', 'main']);

        await git(repoRoot, ['push', '-q', 'origin', 'feature-x'], {
            KODUS_TRACE_AGENT_CMD: agent.command,
            KODUS_AGENT_LOG: agent.logPath,
        });

        const recordPath = `refs/heads/${TRACE_BRANCH}:${(
            await import('../services/trace/decision-branch.service.js')
        ).recordPathForBranch('feature-x')}`;
        await waitFor(async () =>
            git(repoRoot, ['show', recordPath])
                .then(() => true)
                .catch(() => false),
        );

        const record = JSON.parse(
            await git(repoRoot, ['show', recordPath]),
        ) as { branch: string; head: string };
        expect(record.branch).toBe('feature-x');
        expect(record.head).toBe(pushedHead);
        expect((await git(repoRoot, ['branch', '--show-current'])).trim()).toBe(
            'main',
        );

        await waitFor(async () => (await agentCallCount(agent.logPath)) >= 2);
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await agentCallCount(agent.logPath)).toBe(2);

        // Even an explicit user push of the shared ref must not start another
        // distillation. The internal push also sets KODUS_TRACE_SKIP.
        await git(
            repoRoot,
            [
                'push',
                '-q',
                'origin',
                `refs/heads/${TRACE_BRANCH}:refs/heads/${TRACE_BRANCH}`,
            ],
            {
                KODUS_TRACE_AGENT_CMD: agent.command,
                KODUS_AGENT_LOG: agent.logPath,
            },
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(await agentCallCount(agent.logPath)).toBe(2);
    });

    it('keys HEAD:renamed-feature by the destination branch', async () => {
        await runCli(repoRoot, ['trace', 'enable', '--agents', 'claude']);
        const agent = await installFakeAgent();
        await git(repoRoot, ['checkout', '-q', '-b', 'source-feature']);
        await commitFile(
            repoRoot,
            'src/pushed.ts',
            'renamed\n',
            'feat: rename',
        );
        const pushedHead = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();

        await git(repoRoot, ['push', '-q', 'origin', 'HEAD:renamed-feature'], {
            KODUS_TRACE_AGENT_CMD: agent.command,
            KODUS_AGENT_LOG: agent.logPath,
        });

        const { recordPathForBranch } =
            await import('../services/trace/decision-branch.service.js');
        const destinationRecord = `refs/heads/${TRACE_BRANCH}:${recordPathForBranch('renamed-feature')}`;
        await waitFor(async () =>
            git(repoRoot, ['show', destinationRecord])
                .then(() => true)
                .catch(() => false),
        );
        const record = JSON.parse(
            await git(repoRoot, ['show', destinationRecord]),
        ) as { branch: string; head: string };
        expect(record).toMatchObject({
            branch: 'renamed-feature',
            head: pushedHead,
        });
    });

    it('distills every branch in a multi-ref push once', async () => {
        await runCli(repoRoot, ['trace', 'enable', '--agents', 'claude']);
        const agent = await installFakeAgent();
        await git(repoRoot, ['checkout', '-q', '-b', 'multi-one']);
        await commitFile(repoRoot, 'src/pushed.ts', 'one\n', 'feat: one');
        await git(repoRoot, ['checkout', '-q', '-b', 'multi-two', 'main']);
        await commitFile(repoRoot, 'src/pushed.ts', 'two\n', 'feat: two');
        await git(repoRoot, ['checkout', '-q', 'main']);

        await git(
            repoRoot,
            ['push', '-q', 'origin', 'multi-one', 'multi-two'],
            {
                KODUS_TRACE_AGENT_CMD: agent.command,
                KODUS_AGENT_LOG: agent.logPath,
            },
        );

        const { recordPathForBranch } =
            await import('../services/trace/decision-branch.service.js');
        for (const branch of ['multi-one', 'multi-two']) {
            const ref = `refs/heads/${TRACE_BRANCH}:${recordPathForBranch(branch)}`;
            await waitFor(async () =>
                git(repoRoot, ['show', ref])
                    .then(() => true)
                    .catch(() => false),
            );
            const record = JSON.parse(await git(repoRoot, ['show', ref])) as {
                branch: string;
            };
            expect(record.branch).toBe(branch);
        }

        await waitFor(async () => (await agentCallCount(agent.logPath)) >= 4);
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await agentCallCount(agent.logPath)).toBe(4);
    });

    it('skips distillation with a clear message and exit code 0 when no agent CLI is on PATH', async () => {
        await git(repoRoot, ['checkout', '-q', '-b', 'feat/no-cli']);
        await commitFile(repoRoot, 'src/d.ts', 'd\n', 'feat: d');

        const result = await runCli(repoRoot, [
            'trace',
            'distill',
            '--branch',
            'feat/no-cli',
        ]);

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('No agent CLI found on PATH');
        expect(result.stdout).toContain('Capture still works');

        // No record was invented.
        await expect(
            git(repoRoot, [
                'rev-parse',
                '--verify',
                `refs/heads/${TRACE_BRANCH}`,
            ]),
        ).rejects.toThrow();
    });

    it('writes nothing into the working tree across enable, commit and push', async () => {
        await runCli(repoRoot, ['trace', 'enable', '--agents', 'claude']);
        await git(repoRoot, ['add', '.claude']);
        await git(repoRoot, ['commit', '-m', 'chore: enable trace']);

        await git(repoRoot, ['checkout', '-q', '-b', 'feat/clean']);
        await seedSession(repoRoot, 'sess-clean-0001', 'feat/clean');
        await commitFile(repoRoot, 'src/e.ts', 'e\n', 'feat: e');
        await git(repoRoot, ['push', '-q', 'origin', 'feat/clean']);

        expect((await git(repoRoot, ['status', '--porcelain'])).trim()).toBe(
            '',
        );
    });
});
