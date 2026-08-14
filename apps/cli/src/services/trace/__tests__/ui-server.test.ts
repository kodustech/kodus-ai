import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTraceUiServer, type TraceUiServer } from '../ui-server.js';
import { appendRecordLine } from '../session-store.js';
import { saveLocalBranchRecord } from '../local-decisions.js';
import { sessionRecordPath } from '../store-paths.js';

let traceHome: string;
let repoRoot: string;
let server: TraceUiServer;

beforeEach(async () => {
    traceHome = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-ui-home-'));
    process.env.KODUS_TRACE_HOME = traceHome;
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-ui-repo-'));
    server = await startTraceUiServer(repoRoot);
});

afterEach(async () => {
    delete process.env.KODUS_TRACE_HOME;
    await server.close();
    await Promise.all(
        [traceHome, repoRoot].map((dir) =>
            fs.rm(dir, { recursive: true, force: true }),
        ),
    );
});

async function getJson<T>(pathname: string): Promise<T> {
    const response = await fetch(`${server.url}${pathname}`);
    expect(response.status).toBe(200);
    return (await response.json()) as T;
}

async function requestWithHost(
    pathname: string,
    host: string,
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                hostname: '127.0.0.1',
                port: server.port,
                path: pathname,
                headers: { Host: host },
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on('data', (chunk: Buffer) => chunks.push(chunk));
                response.on('end', () =>
                    resolve({
                        status: response.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString('utf-8'),
                    }),
                );
            },
        );
        request.on('error', reject);
        request.end();
    });
}

async function seed(sessionId: string): Promise<void> {
    await appendRecordLine(repoRoot, sessionId, {
        kind: 'session-start',
        sessionId,
        agentType: 'claude-code',
        branch: 'feat/ui',
        baseCommit: 'abc',
        gitRemote: '',
        cliVersion: '1.0.0',
        timestamp: '2026-02-01T10:00:00.000Z',
    });
    await appendRecordLine(repoRoot, sessionId, {
        kind: 'turn-start',
        turnId: 't1',
        prompt: 'move the tax rules into their own module',
        commitBefore: 'abc',
        timestamp: '2026-02-01T10:00:01.000Z',
    });
    await appendRecordLine(repoRoot, sessionId, {
        kind: 'turn-end',
        turnId: 't1',
        response: 'moved them',
        toolCalls: [{ toolName: 'Edit', summary: 'src/tax/rules.ts' }],
        filesModified: [{ path: 'src/tax/rules.ts', action: 'created' }],
        filesRead: ['src/billing/invoice.ts'],
        commands: ['pnpm test'],
        tokenUsage: {
            inputTokens: 10,
            outputTokens: 2,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            apiCallCount: 1,
        },
        commitAfter: 'def',
        timestamp: '2026-02-01T10:00:02.000Z',
    });
}

describe('trace ui server', () => {
    it('serves the app on localhost', async () => {
        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

        const response = await fetch(server.url);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');

        const html = await response.text();
        expect(html).toContain('Kodus Trace');
        expect(html).toContain('aria-label="Kodus Trace home"');
        expect(html).toContain('macrostructure: Narrative Workflow');
        expect(html).toContain('--color-paper: #101019');
        expect(html).toContain('--color-paper-raised: #181825');
        expect(html).toContain('--color-paper-active: #202032');
        expect(html).toContain('--color-rule: #30304b');
        expect(html).toContain('--color-ink: #f3f3f7');
        expect(html).toContain('--color-accent: #f8b76d');
        expect(html).toContain('--color-secondary: #c9bbf2');
        expect(html).toContain('--font-body: "DM Sans", sans-serif');
        expect(html).toContain('--font-mono: "Overpass Mono", monospace');
        expect(html).not.toContain('Local and sanitized');
        expect(html).toContain('overflow-x: clip');
    });

    it('ships a responsive chronological session review', async () => {
        const html = await (await fetch(server.url)).text();

        expect(html).toContain('data-region="sessions"');
        expect(html).toContain('data-region="review"');
        expect(html).toContain('What happened');
        expect(html).toContain('You asked');
        expect(html).toContain('Agent activity');
        expect(html).toContain('Agent response');
        expect(html).toContain('What Trace learned');
        expect(html).toContain('Technical details');
        expect(html).not.toContain('Team memory');
        expect(html).not.toContain('Correction');
        expect(html).not.toContain("getJson('/api/decisions')");
        expect(html).toContain('function renderMarkdown(value)');
        expect(html).toContain('const level = heading[1].length');
        expect(html).not.toContain('heading[1].length + 2');
        expect(html).toContain('class="response markdown"');
        expect(html).toContain('prefers-reduced-motion: reduce');
    });

    it('rejects an untrusted Host header before routing', async () => {
        const response = await requestWithHost(
            '/api/sessions',
            'attacker.test',
        );
        expect(response.status).toBe(421);
        expect(JSON.parse(response.body)).toEqual({
            error: 'Untrusted Host header',
        });
    });

    it('accepts the loopback Host with the actual bound port', async () => {
        const response = await requestWithHost(
            '/api/sessions',
            `127.0.0.1:${server.port}`,
        );
        expect(response.status).toBe(200);
    });

    it('makes no external network call — the page is self-contained', async () => {
        const html = await (await fetch(server.url)).text();

        expect(html).not.toMatch(/<script[^>]+src=/i);
        expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
        expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
    });

    it('renders an empty state instead of failing when there are no sessions', async () => {
        const payload = await getJson<{ sessions: unknown[] }>('/api/sessions');
        expect(payload.sessions).toEqual([]);

        const html = await (await fetch(server.url)).text();
        expect(html).toContain('No sessions captured');
    });

    it('lists sessions read from the local store', async () => {
        await seed('sess-ui-1');

        const payload = await getJson<{
            sessions: Array<{
                sessionId: string;
                branch: string;
                agentType: string;
                turnCount: number;
                filesTouched: string[];
            }>;
        }>('/api/sessions');

        expect(payload.sessions).toHaveLength(1);
        expect(payload.sessions[0]).toMatchObject({
            sessionId: 'sess-ui-1',
            branch: 'feat/ui',
            agentType: 'claude-code',
            turnCount: 1,
            filesTouched: ['src/tax/rules.ts'],
        });
    });

    it('serves the session detail with turns and decisions', async () => {
        await seed('sess-ui-1');
        await saveLocalBranchRecord(repoRoot, {
            version: 1,
            branch: 'feat/ui',
            mergeBase: 'aaa',
            head: 'bbb',
            commits: ['bbb'],
            updatedAt: '2026-02-01T11:00:00.000Z',
            decisions: [
                {
                    id: 'dec-1',
                    type: 'architectural_decision',
                    decision: 'Tax rules live in their own module',
                    scope: ['src/tax'],
                    sessionIds: ['sess-ui-1'],
                },
                {
                    id: 'dec-other',
                    type: 'convention',
                    decision: 'unrelated',
                    scope: ['src/other'],
                    sessionIds: ['sess-elsewhere'],
                },
            ],
        });

        const payload = await getJson<{
            session: {
                turns: Array<{
                    prompt: string;
                    response: string;
                    toolCalls: unknown[];
                    filesModified: unknown[];
                }>;
            };
            decisions: Array<{ id: string }>;
        }>('/api/sessions/sess-ui-1');

        expect(payload.session.turns).toHaveLength(1);
        expect(payload.session.turns[0].prompt).toContain('tax rules');
        expect(payload.session.turns[0].response).toBe('moved them');
        expect(payload.session.turns[0].toolCalls).toHaveLength(1);
        expect(payload.session.turns[0].filesModified).toHaveLength(1);

        expect(payload.decisions.map((d) => d.id)).toEqual(['dec-1']);
    });

    it('renders the parts that exist when a record is truncated', async () => {
        await seed('sess-ui-1');
        await fs.appendFile(
            sessionRecordPath(repoRoot, 'sess-ui-1'),
            '{"kind":"turn-start","tur',
        );

        const payload = await getJson<{
            session: { turns: unknown[]; corruptLines: number };
        }>('/api/sessions/sess-ui-1');

        expect(payload.session.turns).toHaveLength(1);
        expect(payload.session.corruptLines).toBe(1);
    });

    it('redacts legacy record content again before returning UI JSON', async () => {
        const secret = ['sk-', 'Q'.repeat(32)].join('');
        const recordPath = sessionRecordPath(repoRoot, 'legacy-secret');
        await fs.mkdir(path.dirname(recordPath), { recursive: true });
        await fs.writeFile(
            recordPath,
            `${JSON.stringify({
                kind: 'turn-start',
                turnId: 't1',
                prompt: `legacy ${secret}`,
                commitBefore: 'abc',
                timestamp: '2026-02-01T10:00:00.000Z',
            })}\n`,
        );

        const response = await fetch(
            `${server.url}/api/sessions/legacy-secret`,
        );
        const raw = await response.text();
        expect(raw).not.toContain(secret);
        expect(raw).toContain('[REDACTED]');
    });

    it('answers with an empty detail rather than erroring for a missing record', async () => {
        const payload = await getJson<{ session: null; decisions: unknown[] }>(
            '/api/sessions/does-not-exist',
        );

        expect(payload.session).toBeNull();
        expect(payload.decisions).toEqual([]);
    });

    it('404s an unknown route', async () => {
        const response = await fetch(`${server.url}/api/nope`);
        expect(response.status).toBe(404);
    });
});
