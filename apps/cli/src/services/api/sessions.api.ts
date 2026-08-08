import fs from 'fs/promises';
import { request } from './api.real.js';
import { ApiError } from '../../types/errors.js';
import type { SessionApiEvent } from '../../types/session-events.js';
import type { ISessionsApi } from './api.interface.js';
import { getPendingEventsPath } from '../kodus-paths.service.js';
import {
    upsertTurn,
    type LocalTurnRecord,
} from '../local-session-store.service.js';
import { redactText, type RedactedString } from '../redaction.service.js';

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

async function readPending(repoRoot: string): Promise<string[]> {
    const filePath = await getPendingEventsPath(repoRoot);
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return content.split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

async function writePending(repoRoot: string, lines: string[]): Promise<void> {
    const filePath = await getPendingEventsPath(repoRoot);
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
    const filePath = await getPendingEventsPath(repoRoot);
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
                continue;
            }
            failed.push(...lines.slice(i));
            break;
        }
    }

    if (failed.length > 0) {
        await writePending(repoRoot, failed);
    } else {
        const filePath = await getPendingEventsPath(repoRoot);
        await fs.unlink(filePath).catch(() => {});
    }
}

/**
 * Always write a readable local session record, regardless of auth.
 * Secrets are redacted before storage.
 */
async function writeLocalSession(
    event: SessionApiEvent,
    repoRoot: string,
): Promise<void> {
    const sessionId = event.sessionId;
    if (!sessionId) {
        return;
    }

    const base = {
        worktreeRoot: repoRoot,
        agentType: (event as { agentType?: string }).agentType,
        branch: event.branch,
        gitRemote: (event as { gitRemote?: string }).gitRemote,
        cliVersion: (event as { cliVersion?: string }).cliVersion,
    };

    if (event.type === 'session_start') {
        await upsertTurn(repoRoot, sessionId, {
            ...base,
            worktreeRoot: repoRoot,
        });
        return;
    }

    if (event.type === 'turn_start') {
        const prompt = redactText(
            String((event as { prompt?: string }).prompt ?? ''),
        );
        const turn: LocalTurnRecord = {
            turnId: String((event as { turnId?: string }).turnId ?? Date.now()),
            prompt,
            response: '' as RedactedString,
            toolCalls: [],
            filesModified: [],
            filesRead: [],
            commands: [],
            timestamp: event.timestamp,
        };
        await upsertTurn(repoRoot, sessionId, {
            ...base,
            worktreeRoot: repoRoot,
            turn,
        });
        return;
    }

    if (event.type === 'turn_end') {
        const response = redactText(
            String((event as { response?: string }).response ?? ''),
        );
        const turn: LocalTurnRecord = {
            turnId: String((event as { turnId?: string }).turnId ?? Date.now()),
            prompt: '' as RedactedString,
            response,
            toolCalls: ((event as { toolCalls?: unknown[] }).toolCalls ??
                []) as LocalTurnRecord['toolCalls'],
            filesModified: (
                ((
                    event as {
                        filesModified?: Array<string | { path?: string }>;
                    }
                ).filesModified ?? []) as Array<string | { path?: string }>
            )
                .map((f) => (typeof f === 'string' ? f : (f.path ?? '')))
                .filter(Boolean),
            filesRead: ((event as { filesRead?: string[] }).filesRead ??
                []) as string[],
            commands: ((event as { commands?: string[] }).commands ??
                []) as string[],
            timestamp: event.timestamp,
        };
        await upsertTurn(repoRoot, sessionId, {
            ...base,
            worktreeRoot: repoRoot,
            turn,
        });
        return;
    }

    if (event.type === 'session_end') {
        await upsertTurn(repoRoot, sessionId, {
            ...base,
            worktreeRoot: repoRoot,
            endedAt: event.timestamp,
        });
    }
}

/**
 * Redact sensitive fields on a copy of the event before network POST.
 */
function redactEventForNetwork(event: SessionApiEvent): SessionApiEvent {
    const copy = { ...event } as SessionApiEvent & {
        prompt?: string;
        response?: string;
    };
    if (typeof copy.prompt === 'string') {
        copy.prompt = redactText(copy.prompt);
    }
    if (typeof copy.response === 'string') {
        copy.response = redactText(copy.response);
    }
    return copy;
}

export class RealSessionsApi implements ISessionsApi {
    async sendEvent(event: SessionApiEvent, repoRoot: string): Promise<void> {
        // 1. Always write locally first (no-auth mode)
        try {
            await writeLocalSession(event, repoRoot);
        } catch {
            // Local write failures still fail-open for the agent hook
        }

        const token = await getAuthToken();
        if (!token) {
            if (process.env.KODUS_VERBOSE) {
                console.log(
                    '[sessions] No auth token, local-only event:',
                    event.type,
                );
            }
            return;
        }

        // 2. Flush pending, then POST current (redacted)
        try {
            await flushPending(repoRoot, token);
        } catch {
            // Non-blocking
        }

        const networkEvent = redactEventForNetwork(event);
        try {
            await postEvent(networkEvent, token);
        } catch (error) {
            if (
                error instanceof ApiError &&
                error.statusCode < 500 &&
                error.statusCode !== 429
            ) {
                if (process.env.KODUS_VERBOSE) {
                    console.error(
                        '[sessions] Discarding event due to client error:',
                        error.statusCode,
                    );
                }
                return;
            }
            // Network or 5xx — buffer for later retry (outside the repo)
            await appendPending(repoRoot, networkEvent).catch(() => {});
        }
    }
}
