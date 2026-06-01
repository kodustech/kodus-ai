import fs from 'fs/promises';
import path from 'path';
import { request } from './api.real.js';
import { ApiError } from '../../types/errors.js';
import type { SessionApiEvent } from '../../types/session-events.js';
import type { ISessionsApi } from './api.interface.js';

const PENDING_FILE = '.kody/pending-events.jsonl';
const MAX_BUFFER_LINES = 1000;
const ENDPOINT = '/cli/sessions/events';

async function getAuthToken(): Promise<string | null> {
    try {
        const { authService } = await import('../auth.service.js');
        return await authService.getValidToken();
    } catch {
        return null;
    }
}

function buildHeaders(token: string): Record<string, string> {
    const isTeamKey = token.startsWith('kodus_');
    return isTeamKey
        ? { 'X-Team-Key': token }
        : { Authorization: `Bearer ${token}` };
}

async function pendingPath(repoRoot: string): Promise<string> {
    return path.join(repoRoot, PENDING_FILE);
}

async function readPending(repoRoot: string): Promise<string[]> {
    const filePath = await pendingPath(repoRoot);
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return content.split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

async function writePending(repoRoot: string, lines: string[]): Promise<void> {
    const filePath = await pendingPath(repoRoot);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // Truncate old events if buffer exceeds limit
    const truncated =
        lines.length > MAX_BUFFER_LINES
            ? lines.slice(lines.length - MAX_BUFFER_LINES)
            : lines;

    await fs.writeFile(filePath, truncated.join('\n') + '\n', 'utf-8');
}

async function appendPending(
    repoRoot: string,
    event: SessionApiEvent,
): Promise<void> {
    const filePath = await pendingPath(repoRoot);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf-8');
}

async function postEvent(event: SessionApiEvent, token: string): Promise<void> {
    await request<void>(ENDPOINT, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify(event),
    });
}

async function flushPending(repoRoot: string, token: string): Promise<void> {
    const lines = await readPending(repoRoot);
    if (lines.length === 0) {
        return;
    }

    const failed: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        try {
            const event = JSON.parse(line) as SessionApiEvent;
            await postEvent(event, token);
        } catch (error) {
            if (
                error instanceof ApiError &&
                error.statusCode < 500 &&
                error.statusCode !== 429
            ) {
                // 4xx (except 429) — discard, retry won't help
                continue;
            }
            // Network or 5xx/429 — API likely unreachable. Bail out and
            // keep this line plus all remaining for the next flush, so we
            // don't sit here for hours hitting the same dead endpoint.
            failed.push(...lines.slice(i));
            break;
        }
    }

    if (failed.length > 0) {
        await writePending(repoRoot, failed);
    } else {
        // Clean up file
        const filePath = await pendingPath(repoRoot);
        await fs.unlink(filePath).catch(() => {});
    }
}

export class RealSessionsApi implements ISessionsApi {
    async sendEvent(event: SessionApiEvent, repoRoot: string): Promise<void> {
        const token = await getAuthToken();

        if (!token) {
            if (process.env.KODUS_VERBOSE) {
                console.log(
                    '[sessions] No auth token, skipping event:',
                    event.type,
                );
            }
            return;
        }

        // Try to flush pending events first
        try {
            await flushPending(repoRoot, token);
        } catch {
            // Non-blocking — continue with current event
        }

        // Send current event
        try {
            await postEvent(event, token);
        } catch (error) {
            if (
                error instanceof ApiError &&
                error.statusCode < 500 &&
                error.statusCode !== 429
            ) {
                // 4xx — discard
                if (process.env.KODUS_VERBOSE) {
                    console.error(
                        '[sessions] Discarding event due to client error:',
                        error.statusCode,
                    );
                }
                return;
            }
            // Network or retryable — buffer locally
            await appendPending(repoRoot, event).catch(() => {});
        }
    }
}
