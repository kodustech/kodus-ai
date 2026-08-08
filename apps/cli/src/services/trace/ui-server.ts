import http from 'node:http';
import { listSessions, readSessionRecord } from './session-store.js';
import { readAllLocalBranchRecords } from './local-decisions.js';
import { readAllBranchRecords } from './decision-branch.service.js';
import { renderTraceUiHtml } from './ui-html.js';
import type { TraceDecision } from '../../types/trace.js';

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

    const server = http.createServer((req, res) => {
        void handleRequest(gitRoot, req, res);
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
                decisions: await decisionsForSession(gitRoot, sessionId),
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

async function decisionsForSession(
    gitRoot: string,
    sessionId: string,
): Promise<TraceDecision[]> {
    const [local, branch] = await Promise.all([
        readAllLocalBranchRecords(gitRoot),
        readAllBranchRecords(gitRoot).catch(() => []),
    ]);

    const byId = new Map<string, TraceDecision>();
    for (const record of [...local, ...branch]) {
        for (const decision of record.decisions ?? []) {
            if (decision.sessionIds?.includes(sessionId)) {
                byId.set(decision.id, decision);
            }
        }
    }

    return [...byId.values()];
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
        JSON.stringify(payload),
    );
}
