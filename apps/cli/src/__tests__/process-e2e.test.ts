import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { repoKey } from '../services/trace/store-paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CapturedRequest {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: Record<string, unknown>;
}

interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

// ---------------------------------------------------------------------------
// Test-level state
// ---------------------------------------------------------------------------

let mockServer: http.Server;
let mockServerPort: number;
let capturedRequests: CapturedRequest[];
let tmpDir: string;
let homeDir: string;
let cliEntryPoint: string;
let mockServerStatus = 200;

// ---------------------------------------------------------------------------
// Mock HTTP server
// ---------------------------------------------------------------------------

function startMockServer(): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
                chunks.push(chunk as Buffer);
            }
            const rawBody = Buffer.concat(chunks).toString('utf-8');

            let body: Record<string, unknown>;
            try {
                body = JSON.parse(rawBody) as Record<string, unknown>;
            } catch {
                body = { _raw: rawBody };
            }

            capturedRequests.push({
                method: req.method ?? 'GET',
                url: req.url ?? '/',
                headers: req.headers,
                body,
            });

            if (mockServerStatus >= 400) {
                res.writeHead(mockServerStatus, {
                    'Content-Type': 'application/json',
                });
                res.end(JSON.stringify({ message: 'simulated failure' }));
                return;
            }

            const responseBody = JSON.stringify({
                data: { accepted: true },
                statusCode: 200,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(responseBody);
        });

        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr === 'object') {
                resolve({ server, port: addr.port });
            } else {
                reject(new Error('Failed to bind mock server'));
            }
        });

        server.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// Helper: spawn the CLI as a child process
// ---------------------------------------------------------------------------

interface RunHookOptions {
    cwd?: string;
    /** Replaces the default environment entries, key by key. */
    env?: Record<string, string | undefined>;
}

async function runHook(
    agent: string,
    hookName: string,
    payload: object,
    options?: RunHookOptions,
): Promise<RunResult> {
    const cwd = options?.cwd ?? tmpDir;

    const baseEnv: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        NODE_PATH: process.env.NODE_PATH,
        KODUS_API_URL: `http://127.0.0.1:${mockServerPort}`,
        KODUS_TEAM_KEY: 'kodus_test_key_e2e_12345',
        // Use the dedicated Trace seam. Never repurpose HOME in a process
        // test: doing so can redirect unrelated tools and configuration.
        KODUS_TRACE_HOME: path.join(homeDir, '.kodus'),
        KODUS_VERBOSE: 'true',
        NO_UPDATE_NOTIFIER: '1',
        NODE_OPTIONS: '',
        ...(options?.env ?? {}),
    };

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseEnv)) {
        if (value !== undefined) {
            env[key] = value;
        }
    }

    return new Promise<RunResult>((resolve) => {
        const child = spawn(
            process.execPath,
            [cliEntryPoint, 'trace', 'hooks', agent, hookName],
            {
                cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                env,
                timeout: 15_000,
            },
        );

        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];

        child.stdout!.on('data', (data: Buffer) => {
            stdoutChunks.push(data.toString());
        });

        child.stderr!.on('data', (data: Buffer) => {
            stderrChunks.push(data.toString());
        });

        const payloadStr = JSON.stringify(payload);
        child.stdin!.write(payloadStr);
        child.stdin!.end();

        child.on('close', (code) => {
            resolve({
                exitCode: code ?? 0,
                stdout: stdoutChunks.join(''),
                stderr: stderrChunks.join(''),
            });
        });

        child.on('error', (err) => {
            resolve({
                exitCode: 1,
                stdout: stdoutChunks.join(''),
                stderr: `spawn error: ${err.message}`,
            });
        });
    });
}

/**
 * Wait until the mock server has received at least `count` requests,
 * or until `timeoutMs` elapses.
 */
async function waitForRequests(count: number, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (capturedRequests.length < count && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 100));
    }
}

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

describe('Process E2E — session hooks', { timeout: 60_000 }, () => {
    beforeAll(async () => {
        // Resolve CLI entry point (compiled JS)
        const cliRoot = path.resolve(
            import.meta.dirname ??
                path.dirname(new URL(import.meta.url).pathname),
            '../..',
        );
        cliEntryPoint = path.join(cliRoot, 'dist', 'index.js');

        // Verify the entry point exists (requires `pnpm build` beforehand)
        await fs.access(cliEntryPoint);

        // Create a temp directory that acts as HOME + git repo
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-e2e-'));

        // Initialize a bare git repo so gitService.isGitRepository() returns true
        await new Promise<void>((resolve, reject) => {
            const git = spawn('git', ['init', '--initial-branch=main'], {
                cwd: tmpDir,
            });
            git.on('close', (code) =>
                code === 0
                    ? resolve()
                    : reject(new Error(`git init failed with code ${code}`)),
            );
            git.on('error', reject);
        });

        // Create an initial commit so HEAD exists
        await new Promise<void>((resolve, reject) => {
            const git = spawn(
                'git',
                ['commit', '--allow-empty', '-m', 'initial'],
                {
                    cwd: tmpDir,
                    env: {
                        ...process.env,
                        GIT_AUTHOR_NAME: 'Test',
                        GIT_AUTHOR_EMAIL: 'test@test.com',
                        GIT_COMMITTER_NAME: 'Test',
                        GIT_COMMITTER_EMAIL: 'test@test.com',
                    },
                },
            );
            git.on('close', (code) =>
                code === 0
                    ? resolve()
                    : reject(new Error(`git commit failed with code ${code}`)),
            );
            git.on('error', reject);
        });

        homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-e2e-home-'));

        // Start mock HTTP server
        const { server, port } = await startMockServer();
        mockServer = server;
        mockServerPort = port;
    });

    afterAll(async () => {
        if (mockServer) {
            await new Promise<void>((resolve) => {
                mockServer.close(() => resolve());
            });
        }

        for (const dir of [tmpDir, homeDir]) {
            if (dir) {
                await fs
                    .rm(dir, { recursive: true, force: true })
                    .catch(() => {});
            }
        }
    });

    beforeEach(() => {
        capturedRequests = [];
        mockServerStatus = 200;
    });

    // -----------------------------------------------------------------------
    // Claude Code full session lifecycle
    // -----------------------------------------------------------------------

    it('Claude Code — full session lifecycle sends events in order', async () => {
        const sessionId = `cc-session-${Date.now()}`;
        const transcriptPath = path.join(tmpDir, '.claude', 'transcript.jsonl');

        // 1. session-start
        const startResult = await runHook('claude-code', 'session-start', {
            session_id: sessionId,
            transcript_path: transcriptPath,
        });
        expect(startResult.exitCode).toBe(0);

        // 2. user-prompt-submit (turn start)
        const promptResult = await runHook(
            'claude-code',
            'user-prompt-submit',
            {
                session_id: sessionId,
                transcript_path: transcriptPath,
                prompt: 'Fix the login bug in auth.ts',
            },
        );
        expect(promptResult.exitCode).toBe(0);

        // 3. stop (turn end)
        const stopResult = await runHook('claude-code', 'stop', {
            session_id: sessionId,
            transcript_path: transcriptPath,
        });
        expect(stopResult.exitCode).toBe(0);

        // 4. session-end
        const endResult = await runHook('claude-code', 'session-end', {
            session_id: sessionId,
            transcript_path: transcriptPath,
        });
        expect(endResult.exitCode).toBe(0);

        // Wait for events to arrive at mock server
        await waitForRequests(4, 10_000);

        const eventRequests = capturedRequests.filter((r) =>
            r.url?.includes('/cli/sessions/events'),
        );
        expect(eventRequests.length).toBeGreaterThanOrEqual(4);

        const eventTypes = eventRequests.map((r) => r.body.type);
        expect(eventTypes).toContain('session_start');
        expect(eventTypes).toContain('turn_start');
        expect(eventTypes).toContain('turn_end');
        expect(eventTypes).toContain('session_end');

        // Verify session IDs match
        for (const req of eventRequests) {
            expect(req.body.sessionId).toBe(sessionId);
        }

        // Verify auth header
        for (const req of eventRequests) {
            expect(req.headers['x-team-key']).toBe('kodus_test_key_e2e_12345');
        }

        // Verify session_start fields
        const sessionStartEvent = eventRequests.find(
            (r) => r.body.type === 'session_start',
        );
        expect(sessionStartEvent).toBeDefined();
        expect(sessionStartEvent!.body.agentType).toBe('claude-code');
        expect(sessionStartEvent!.body.branch).toBe('main');
        expect(sessionStartEvent!.body.cliVersion).toBeTruthy();

        // Verify turn_start has the prompt
        const turnStartEvent = eventRequests.find(
            (r) => r.body.type === 'turn_start',
        );
        expect(turnStartEvent).toBeDefined();
        expect(turnStartEvent!.body.prompt).toBe(
            'Fix the login bug in auth.ts',
        );
        expect(turnStartEvent!.body.turnId).toBeTruthy();

        // Verify turn_end structure
        const turnEndEvent = eventRequests.find(
            (r) => r.body.type === 'turn_end',
        );
        expect(turnEndEvent).toBeDefined();
        expect(turnEndEvent!.body.turnId).toBeTruthy();
        expect(turnEndEvent!.body).toHaveProperty('toolCalls');
        expect(turnEndEvent!.body).toHaveProperty('filesModified');
        expect(turnEndEvent!.body).toHaveProperty('tokenUsage');

        // Verify ordering: session_start before session_end
        const startIdx = eventTypes.indexOf('session_start');
        const endIdx = eventTypes.lastIndexOf('session_end');
        expect(startIdx).toBeLessThan(endIdx);
    });

    // -----------------------------------------------------------------------
    // Cursor full session lifecycle
    // -----------------------------------------------------------------------

    it('Cursor — full session lifecycle sends events in order', async () => {
        const sessionId = `cursor-session-${Date.now()}`;

        const startResult = await runHook('cursor', 'sessionStart', {
            session_id: sessionId,
        });
        expect(startResult.exitCode).toBe(0);

        const promptResult = await runHook('cursor', 'beforeSubmitPrompt', {
            session_id: sessionId,
            prompt: 'Refactor the database module',
        });
        expect(promptResult.exitCode).toBe(0);

        const stopResult = await runHook('cursor', 'stop', {
            session_id: sessionId,
        });
        expect(stopResult.exitCode).toBe(0);

        const endResult = await runHook('cursor', 'sessionEnd', {
            session_id: sessionId,
        });
        expect(endResult.exitCode).toBe(0);

        await waitForRequests(4, 10_000);

        const eventRequests = capturedRequests.filter((r) =>
            r.url?.includes('/cli/sessions/events'),
        );
        expect(eventRequests.length).toBeGreaterThanOrEqual(4);

        const eventTypes = eventRequests.map((r) => r.body.type);
        expect(eventTypes).toContain('session_start');
        expect(eventTypes).toContain('turn_start');
        expect(eventTypes).toContain('turn_end');
        expect(eventTypes).toContain('session_end');

        // Verify agent type is cursor
        const sessionStartEvent = eventRequests.find(
            (r) => r.body.type === 'session_start',
        );
        expect(sessionStartEvent!.body.agentType).toBe('cursor');

        // Verify prompt
        const turnStartEvent = eventRequests.find(
            (r) => r.body.type === 'turn_start',
        );
        expect(turnStartEvent!.body.prompt).toBe(
            'Refactor the database module',
        );

        for (const req of eventRequests) {
            expect(req.body.sessionId).toBe(sessionId);
        }
    });

    // -----------------------------------------------------------------------
    // Codex AfterAgent hook
    // -----------------------------------------------------------------------

    it('Codex — AfterAgent hook sends turn_end', async () => {
        const sessionId = `codex-session-${Date.now()}`;

        const result = await runHook('codex', 'AfterAgent', {
            session_id: sessionId,
        });
        expect(result.exitCode).toBe(0);

        // Codex AfterAgent → TurnEnd. Since no prior TurnStart,
        // lifecycle emits synthetic turn_start before turn_end.
        await waitForRequests(2, 10_000);

        const eventRequests = capturedRequests.filter((r) =>
            r.url?.includes('/cli/sessions/events'),
        );
        expect(eventRequests.length).toBeGreaterThanOrEqual(1);

        const eventTypes = eventRequests.map((r) => r.body.type);
        expect(eventTypes).toContain('turn_end');

        const turnEndReq = eventRequests.find(
            (r) => r.body.type === 'turn_end',
        );
        expect(turnEndReq).toBeDefined();
        expect(turnEndReq!.body.sessionId).toBe(sessionId);
    });

    // -----------------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------------

    it('Invalid hook name exits cleanly with no events sent', async () => {
        const result = await runHook('claude-code', 'nonexistent-hook', {
            session_id: 'should-not-matter',
        });

        expect(result.exitCode).toBe(0);

        await new Promise((r) => setTimeout(r, 2000));

        const eventRequests = capturedRequests.filter((r) =>
            r.url?.includes('/cli/sessions/events'),
        );
        expect(eventRequests.length).toBe(0);
    });

    it('Hook in non-git directory exits cleanly with no events sent', async () => {
        const nonGitDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-e2e-nogit-'),
        );

        try {
            const result = await runHook(
                'claude-code',
                'session-start',
                {
                    session_id: 'should-not-send',
                    transcript_path: '/tmp/fake-transcript.jsonl',
                },
                { cwd: nonGitDir },
            );

            expect(result.exitCode).toBe(0);

            await new Promise((r) => setTimeout(r, 2000));

            const eventRequests = capturedRequests.filter((r) =>
                r.url?.includes('/cli/sessions/events'),
            );
            expect(eventRequests.length).toBe(0);
        } finally {
            await fs
                .rm(nonGitDir, { recursive: true, force: true })
                .catch(() => {});
        }
    });

    it('Hook with empty payload exits cleanly', async () => {
        const result = await runHook('claude-code', 'session-start', {});

        expect(result.exitCode).toBe(0);

        await waitForRequests(1, 5000);

        const eventRequests = capturedRequests.filter((r) =>
            r.url?.includes('/cli/sessions/events'),
        );
        expect(eventRequests.length).toBeGreaterThanOrEqual(1);

        const event = eventRequests[0];
        expect(event.body.type).toBe('session_start');
        expect(event.body.sessionId).toBe('');
    });

    // -----------------------------------------------------------------------
    // Local store, no-auth mode, and redaction
    // -----------------------------------------------------------------------

    async function readLocalRecord(sessionId: string): Promise<string> {
        const recordsDir = path.join(
            homeDir,
            '.kodus',
            'sessions',
            repoKey(await fs.realpath(tmpDir)),
            'records',
        );
        return fs.readFile(
            path.join(recordsDir, `${sessionId}.jsonl`),
            'utf-8',
        );
    }

    async function driveSession(
        sessionId: string,
        prompt: string,
        env?: Record<string, string | undefined>,
    ): Promise<RunResult[]> {
        const transcriptPath = path.join(tmpDir, '.claude', 'transcript.jsonl');
        const results: RunResult[] = [];

        results.push(
            await runHook(
                'claude-code',
                'session-start',
                { session_id: sessionId, transcript_path: transcriptPath },
                { env },
            ),
        );
        results.push(
            await runHook(
                'claude-code',
                'user-prompt-submit',
                {
                    session_id: sessionId,
                    transcript_path: transcriptPath,
                    prompt,
                },
                { env },
            ),
        );
        results.push(
            await runHook(
                'claude-code',
                'stop',
                { session_id: sessionId, transcript_path: transcriptPath },
                { env },
            ),
        );
        results.push(
            await runHook(
                'claude-code',
                'session-end',
                { session_id: sessionId, transcript_path: transcriptPath },
                { env },
            ),
        );

        return results;
    }

    it('with a token, a session writes locally and posts to the API', async () => {
        const sessionId = `local-and-api-${Date.now()}`;

        await driveSession(sessionId, 'add a retry to the webhook sender');
        await waitForRequests(4, 10_000);

        const record = await readLocalRecord(sessionId);
        expect(record).toContain('"kind":"session-start"');
        expect(record).toContain('"kind":"turn-start"');
        expect(record).toContain('"kind":"turn-end"');
        expect(record).toContain('"kind":"session-end"');
        expect(record).toContain('add a retry to the webhook sender');

        const eventRequests = capturedRequests.filter((r) =>
            r.url?.includes('/cli/sessions/events'),
        );
        expect(eventRequests.length).toBeGreaterThanOrEqual(4);
    });

    it('with no token and no reachable API, every hook exits zero with empty stderr and the record is complete', async () => {
        const sessionId = `offline-${Date.now()}`;

        const results = await driveSession(
            sessionId,
            'switch the queue to at-least-once delivery',
            {
                // No credentials at all, and an API that refuses connections.
                KODUS_TEAM_KEY: undefined,
                KODUS_API_URL: 'http://127.0.0.1:1',
                KODUS_VERBOSE: undefined,
            },
        );

        for (const result of results) {
            expect(result.exitCode).toBe(0);
            expect(result.stderr).toBe('');
        }

        const record = await readLocalRecord(sessionId);
        expect(record).toContain('"kind":"session-start"');
        expect(record).toContain('"kind":"session-end"');
        expect(record).toContain('at-least-once delivery');

        const eventRequests = capturedRequests.filter((r) =>
            r.url?.includes('/cli/sessions/events'),
        );
        expect(eventRequests).toHaveLength(0);
    });

    it('with a token and the API returning 500, the local record is complete and the event is buffered for retry', async () => {
        mockServerStatus = 500;
        const sessionId = `api-500-${Date.now()}`;

        const results = await driveSession(sessionId, 'cache the tax table');
        for (const result of results) {
            expect(result.exitCode).toBe(0);
        }

        const record = await readLocalRecord(sessionId);
        expect(record).toContain('"kind":"session-end"');
        expect(record).toContain('cache the tax table');

        const pendingPath = path.join(
            homeDir,
            '.kodus',
            'sessions',
            repoKey(await fs.realpath(tmpDir)),
            'pending-events.jsonl',
        );
        const buffered = await fs.readFile(pendingPath, 'utf-8');
        expect(buffered).toContain('"type":"session_start"');

        // …and the retry drains it once the API recovers.
        mockServerStatus = 200;
        capturedRequests = [];
        await driveSession(`api-recovered-${Date.now()}`, 'unrelated');
        await waitForRequests(5, 10_000);

        const replayed = capturedRequests.filter(
            (r) =>
                r.url?.includes('/cli/sessions/events') &&
                r.body.sessionId === sessionId,
        );
        expect(replayed.length).toBeGreaterThan(0);
    });

    it('a planted secret never reaches a captured request, the local store, or the repository', async () => {
        const sessionId = `secret-${Date.now()}`;
        // Force every sanitized request into the pending retry buffer too, so
        // this one flow searches both transport and offline persistence.
        mockServerStatus = 500;
        // Assembled rather than written as a literal: a literal with this
        // shape trips GitHub's push protection on a string that was never a
        // credential.
        const secret = [
            'sk-',
            'ant-',
            'api03-',
            'PLANTED',
            '0'.repeat(30),
        ].join('');

        await driveSession(
            sessionId,
            `use this key to call the API: ${secret} and then summarise`,
        );
        await waitForRequests(4, 10_000);

        for (const request of capturedRequests) {
            expect(JSON.stringify(request.body)).not.toContain(secret);
        }

        const record = await readLocalRecord(sessionId);
        expect(record).not.toContain(secret);
        expect(record).toContain('[REDACTED]');

        // Nowhere else in the store either — the hook log carries the same
        // prompt and is just as much a file on the developer's disk.
        const storeOffenders: string[] = [];
        const walkStore = async (dir: string): Promise<void> => {
            for (const entry of await fs.readdir(dir, {
                withFileTypes: true,
            })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walkStore(full);
                    continue;
                }
                const content = await fs
                    .readFile(full, 'utf-8')
                    .catch(() => '');
                if (content.includes(secret)) {
                    storeOffenders.push(full);
                }
            }
        };
        await walkStore(path.join(homeDir, '.kodus'));
        expect(storeOffenders).toEqual([]);

        // Nothing anywhere under the repository working tree, either.
        const offenders: string[] = [];
        const walk = async (dir: string): Promise<void> => {
            for (const entry of await fs.readdir(dir, {
                withFileTypes: true,
            })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === '.git') {
                        continue;
                    }
                    await walk(full);
                    continue;
                }
                const content = await fs
                    .readFile(full, 'utf-8')
                    .catch(() => '');
                if (content.includes(secret)) {
                    offenders.push(full);
                }
            }
        };
        await walk(tmpDir);
        expect(offenders).toEqual([]);
    });

    it('leaves the working tree clean and writes nothing inside the repository', async () => {
        const sessionId = `clean-tree-${Date.now()}`;
        await driveSession(sessionId, 'rename the settings module');

        const status = await new Promise<string>((resolve) => {
            const child = spawn('git', ['status', '--porcelain'], {
                cwd: tmpDir,
            });
            let out = '';
            child.stdout.on('data', (chunk: Buffer) => {
                out += chunk.toString();
            });
            child.on('close', () => resolve(out));
        });

        expect(status.trim()).toBe('');

        // The old release buffered raw events into the repository root.
        await expect(
            fs.access(path.join(tmpDir, '.kody', 'pending-events.jsonl')),
        ).rejects.toThrow();
    });

    it('never spawns an agent CLI during a turn hook', async () => {
        const fakeBin = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-fake-bin-'),
        );
        const marker = path.join(fakeBin, 'spawned');

        try {
            for (const name of ['claude', 'codex', 'gemini', 'cursor-agent']) {
                await fs.writeFile(
                    path.join(fakeBin, name),
                    `#!/bin/sh
echo "$0" >> ${JSON.stringify(marker)}
`,
                    { mode: 0o755 },
                );
            }

            await driveSession(`no-spawn-${Date.now()}`, 'do something', {
                PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
            });

            await expect(fs.access(marker)).rejects.toThrow();
        } finally {
            await fs.rm(fakeBin, { recursive: true, force: true });
        }
    });

    it('Invalid agent name exits with no events sent', async () => {
        await runHook('nonexistent-agent', 'session-start', {
            session_id: 'should-not-send',
        });

        await new Promise((r) => setTimeout(r, 2000));

        const eventRequests = capturedRequests.filter((r) =>
            r.url?.includes('/cli/sessions/events'),
        );
        expect(eventRequests.length).toBe(0);
    });
});
