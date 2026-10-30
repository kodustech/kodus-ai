import http from 'node:http';
import { listSessions, readSessionRecord } from './session-store.js';
import { readAllLocalBranchRecords } from './local-decisions.js';
import { readAllBranchRecords } from './decision-branch.service.js';
import { renderTraceUiHtml } from './ui-html.js';
import type { TraceDecision } from '../../types/trace.js';
import { redactDeep } from './redaction.js';

export interface TraceUiServer {
    url: string;
    port: number;
    close: () => Promise<void>;
}

/**
 * A local single-page app over the local store. No authentication, because
 * there is nothing here the person running it cannot already read, and no
 * network calls, because the whole point is that it works offline.
 */
export async function startTraceUiServer(
    gitRoot: string,
    options: { port?: number; host?: string } = {},
): Promise<TraceUiServer> {
    const host = options.host ?? '127.0.0.1';
    let decisionIndex: Promise<Map<string, TraceDecision[]>> | null = null;
    const decisionsForSession = async (
        sessionId: string,
    ): Promise<TraceDecision[]> => {
        decisionIndex ??= loadDecisionIndex(gitRoot);
        return (await decisionIndex).get(sessionId) ?? [];
    };

    let boundPort = 0;
    const server = http.createServer((req, res) => {
        if (!isAllowedHost(req.headers.host, boundPort)) {
            sendJson(res, 421, { error: 'Untrusted Host header' });
            return;
        }
        void handleRequest(gitRoot, req, res, decisionsForSession);
    });

    const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, host, () => {
            const address = server.address();
            if (address && typeof address === 'object') {
                resolve(address.port);
            } else {
                reject(new Error('Failed to bind the trace UI server'));
            }
        });
    });
    boundPort = port;

    return {
        port,
        url: `http://${host}:${port}`,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
            }),
    };
}

async function handleRequest(
    gitRoot: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    decisionsForSession: (sessionId: string) => Promise<TraceDecision[]>,
): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    try {
        if (url.pathname === '/' || url.pathname === '/index.html') {
            send(res, 200, 'text/html; charset=utf-8', renderTraceUiHtml());
            return;
        }

        if (url.pathname === '/api/sessions') {
            const sessions = await listSessions(gitRoot);
            sendJson(res, 200, { sessions });
            return;
        }

        if (url.pathname.startsWith('/api/sessions/')) {
            const sessionId = decodeURIComponent(
                url.pathname.slice('/api/sessions/'.length),
            );
            const session = await readSessionRecord(gitRoot, sessionId);

            if (!session) {
                // A record that is gone is an empty detail view, not a crash.
                sendJson(res, 200, { session: null, decisions: [] });
                return;
            }

            sendJson(res, 200, {
                session,
                decisions: await decisionsForSession(sessionId),
            });
            return;
        }

        sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
        sendJson(res, 500, {
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
}

async function loadDecisionIndex(
    gitRoot: string,
): Promise<Map<string, TraceDecision[]>> {
    const [local, branch] = await Promise.all([
        readAllLocalBranchRecords(gitRoot),
        readAllBranchRecords(gitRoot).catch(() => []),
    ]);

    const bySession = new Map<string, Map<string, TraceDecision>>();
    for (const record of [...local, ...branch]) {
        for (const decision of record.decisions ?? []) {
            for (const sessionId of decision.sessionIds ?? []) {
                const byId = bySession.get(sessionId) ?? new Map();
                byId.set(decision.id, decision);
                bySession.set(sessionId, byId);
            }
        }
    }

    return new Map(
        [...bySession.entries()].map(([sessionId, byId]) => [
            sessionId,
            [...byId.values()],
        ]),
    );
}

function send(
    res: http.ServerResponse,
    status: number,
    contentType: string,
    body: string,
): void {
    res.writeHead(status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function sendJson(
    res: http.ServerResponse,
    status: number,
    payload: unknown,
): void {
    send(
        res,
        status,
        'application/json; charset=utf-8',
        JSON.stringify(redactDeep(payload)),
    );
}

export function isAllowedHost(
    hostHeader: string | undefined,
    port: number,
): boolean {
    if (!hostHeader || !Number.isInteger(port) || port <= 0) {
        return false;
    }
    return new Set([
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        `[::1]:${port}`,
    ]).has(hostHeader.toLowerCase());
}
