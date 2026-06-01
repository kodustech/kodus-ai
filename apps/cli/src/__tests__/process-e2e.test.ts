import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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
let cliEntryPoint: string;

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

            let body: Record<string, unknown> = {};
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

async function runHook(
    agent: string,
    hookName: string,
    payload: object,
    options?: { cwd?: string },
): Promise<RunResult> {
    const cwd = options?.cwd ?? tmpDir;

    return new Promise<RunResult>((resolve) => {
        const child = spawn(
            process.execPath,
            [
                cliEntryPoint,
                'decisions',
                'hooks',
                agent,
                hookName,
            ],
            {
                cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {
                    PATH: process.env.PATH,
                    NODE_PATH: process.env.NODE_PATH,
                    KODUS_API_URL: `http://127.0.0.1:${mockServerPort}`,
                    KODUS_TEAM_KEY: 'kodus_test_key_e2e_12345',
                    HOME: tmpDir,
                    KODUS_VERBOSE: 'true',
                    NO_UPDATE_NOTIFIER: '1',
                    NODE_OPTIONS: '',
                },
                timeout: 15_000,
            },
        );

        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];

        child.stdout.on('data', (data: Buffer) => {
            stdoutChunks.push(data.toString());
        });

        child.stderr.on('data', (data: Buffer) => {
            stderrChunks.push(data.toString());
        });

        const payloadStr = JSON.stringify(payload);
        child.stdin.write(payloadStr);
        child.stdin.end();

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
async function waitForRequests(
    count: number,
    timeoutMs = 5000,
): Promise<void> {
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
            import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
            '../..',
        );
        cliEntryPoint = path.join(cliRoot, 'dist', 'index.js');

        // Verify the entry point exists (requires `yarn build` beforehand)
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
                    : reject(
                          new Error(
                              `git commit failed with code ${code}`,
                          ),
                      ),
            );
            git.on('error', reject);
        });

        // Create .kody and .kodus directories
        await fs.mkdir(path.join(tmpDir, '.kody'), { recursive: true });
        await fs.mkdir(path.join(tmpDir, '.kodus'), { recursive: true });

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

        if (tmpDir) {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    beforeEach(() => {
        capturedRequests = [];
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
        const promptResult = await runHook('claude-code', 'user-prompt-submit', {
            session_id: sessionId,
            transcript_path: transcriptPath,
            prompt: 'Fix the login bug in auth.ts',
        });
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
        expect(turnStartEvent!.body.prompt).toBe('Fix the login bug in auth.ts');
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
            await fs.rm(nonGitDir, { recursive: true, force: true }).catch(
                () => {},
            );
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

    it('Invalid agent name exits with no events sent', async () => {
        const result = await runHook('nonexistent-agent', 'session-start', {
            session_id: 'should-not-send',
        });

        await new Promise((r) => setTimeout(r, 2000));

        const eventRequests = capturedRequests.filter((r) =>
            r.url?.includes('/cli/sessions/events'),
        );
        expect(eventRequests.length).toBe(0);
    });
});
