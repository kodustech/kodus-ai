import path from 'node:path';
import { createRequire } from 'node:module';
import { gitService } from './git.service.js';
import { hookLogger } from './hook-logger.service.js';
import { transcriptService } from './transcript.service.js';
import {
    saveLocal,
    loadLocal,
    removeLocal,
    listStaleSessions,
} from './session-local.service.js';
import { api } from './api/index.js';
import type {
    LifecycleEvent,
    AgentType,
    ToolCall,
    FileChange,
} from '../types/session.js';
import type { SessionApiEvent } from '../types/session-events.js';
import {
    buildSessionEndEvent,
    buildSessionStartEvent,
    buildSubagentEndEvent,
    buildSubagentStartEvent,
    buildTurnEndEvent,
    buildTurnStartEvent,
} from './lifecycle-events.js';
import { createEmptyTokenUsage } from './lifecycle-turn-data.js';
import { collectTurnTranscriptData } from './lifecycle-transcript.js';
import {
    getBranchSafe,
    getHeadSafe,
    getRemoteSafe,
} from './lifecycle-git-context.js';
import { createTurnLocalState } from './lifecycle-local-turn-state.js';
import { redact } from './trace/redaction.js';
import {
    appendRecordLine,
    pruneOldSessions,
    SESSION_RETENTION_MS,
} from './trace/session-store.js';
import type { TraceToolCallRecord } from '../types/trace.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

function sendEvent(event: SessionApiEvent, repoRoot: string): void {
    // Fire and forget — never blocks the agent
    api.sessions.sendEvent(event, repoRoot).catch(() => {});
}

/**
 * Local capture is the product, not a cache of the API. Every write here is
 * best-effort so a full disk cannot take the agent down with it, but it happens
 * unconditionally — with no token, with no network, with the API returning 500.
 */
async function recordLocally(
    repoRoot: string,
    sessionId: string,
    line: Parameters<typeof appendRecordLine>[2],
): Promise<void> {
    try {
        await appendRecordLine(repoRoot, sessionId, line);
    } catch {
        // Capture must never block the agent.
    }
}

/**
 * Agents report file paths as absolute. Everything downstream — decision scope,
 * `kodus trace <path>`, the review context pack — matches repo-relative paths,
 * so an absolute path here silently never matches anything.
 */
export function toRepoRelative(repoRoot: string, filePath: string): string {
    if (!filePath) {
        return filePath;
    }

    let value = filePath;
    if (path.isAbsolute(value)) {
        const relative = path.relative(repoRoot, value);
        // A path outside the repository stays as it was: rewriting it to
        // `../../etc` would be worse than leaving it alone.
        if (relative && !relative.startsWith('..')) {
            value = relative;
        }
    }

    return value.split(path.sep).join('/');
}

function toTraceToolCalls(
    repoRoot: string,
    toolCalls: ToolCall[],
): TraceToolCallRecord[] {
    return toolCalls.slice(0, 200).map((call) => ({
        toolName: call.toolName,
        summary: summarizeToolInput(repoRoot, call),
        fileAffected: call.fileAffected
            ? toRepoRelative(repoRoot, call.fileAffected)
            : undefined,
    }));
}

export function summarizeToolInput(
    repoRoot: string,
    call: ToolCall,
): string | undefined {
    const input = call.input ?? {};

    // A path is rewritten repo-relative like every other path this feature
    // stores. The selected value is redacted in full before truncation below.
    const command = pickInputString(input, 'command');
    const filePath =
        pickInputString(input, 'file_path') ?? pickInputString(input, 'path');

    const candidate =
        command ??
        (filePath ? toRepoRelative(repoRoot, filePath) : undefined) ??
        pickInputString(input, 'pattern') ??
        pickInputString(input, 'description');

    if (!candidate) {
        return undefined;
    }

    return truncateRedacted(redact(candidate), 300);
}

function truncateRedacted(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }

    const truncated = value.slice(0, maxLength);
    const placeholder = '[REDACTED]';
    for (
        let prefixLength = 1;
        prefixLength < placeholder.length;
        prefixLength += 1
    ) {
        const prefix = placeholder.slice(0, prefixLength);
        if (truncated.endsWith(prefix)) {
            return `${truncated.slice(0, maxLength - placeholder.length)}${placeholder}`;
        }
    }
    return truncated;
}

function pickInputString(
    input: Record<string, unknown>,
    key: string,
): string | undefined {
    const value = input[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

class LifecycleService {
    async dispatch(
        repoRoot: string,
        agentType: AgentType,
        event: LifecycleEvent,
    ): Promise<void> {
        await hookLogger.init(repoRoot);

        switch (event.type) {
            case 'SessionStart':
                await this.handleSessionStart(repoRoot, agentType, event);
                break;
            case 'TurnStart':
                await this.handleTurnStart(repoRoot, agentType, event);
                break;
            case 'TurnEnd':
                await this.handleTurnEnd(repoRoot, agentType, event);
                break;
            case 'SessionEnd':
                await this.handleSessionEnd(repoRoot, agentType, event);
                break;
            case 'SubagentStart':
                await this.handleSubagentStart(repoRoot, agentType, event);
                break;
            case 'SubagentEnd':
                await this.handleSubagentEnd(repoRoot, agentType, event);
                break;
        }
    }

    // -------------------------------------------------------------------------
    // Session Start
    // -------------------------------------------------------------------------

    private async handleSessionStart(
        repoRoot: string,
        agentType: AgentType,
        event: LifecycleEvent,
    ): Promise<void> {
        await hookLogger.info('session-start', 'lifecycle', {
            agent: agentType,
            model_session_id: event.sessionId,
            transcript_path: event.sessionRef,
        });

        // Clean up stale sessions from previous crashes (> 30 min old)
        await this.cleanupStaleSessions(repoRoot, agentType);

        // Retention: session-start is the only moment this feature reliably
        // runs on an otherwise idle machine, so the prune rides along here.
        await pruneOldSessions(repoRoot, SESSION_RETENTION_MS).catch(() => []);

        const [branch, baseCommit, gitRemote] = await Promise.all([
            getBranchSafe(gitService),
            getHeadSafe(gitService),
            getRemoteSafe(gitService),
        ]);

        await recordLocally(repoRoot, event.sessionId, {
            kind: 'session-start',
            sessionId: event.sessionId,
            agentType,
            branch,
            baseCommit,
            gitRemote,
            cliVersion: pkg.version,
            timestamp: new Date().toISOString(),
        });

        sendEvent(
            buildSessionStartEvent({
                sessionId: event.sessionId,
                branch,
                timestamp: new Date().toISOString(),
                agentType,
                gitRemote,
                baseCommit,
                cliVersion: pkg.version,
            }),
            repoRoot,
        );
    }

    // -------------------------------------------------------------------------
    // Turn Start (user-prompt-submit)
    // -------------------------------------------------------------------------

    private async handleTurnStart(
        repoRoot: string,
        agentType: AgentType,
        event: LifecycleEvent,
    ): Promise<void> {
        await hookLogger.info('turn-start', 'lifecycle', {
            agent: agentType,
            model_session_id: event.sessionId,
            prompt: redact(event.prompt ?? '').slice(0, 200),
        });

        const [branch, commitBefore] = await Promise.all([
            getBranchSafe(gitService),
            getHeadSafe(gitService),
        ]);

        const turnId = `${Date.now()}`;

        const transcriptPath = event.sessionRef ?? '';
        const fs = await import('fs/promises');
        const localTurnState = await createTurnLocalState({
            turnId,
            transcriptPath,
            stat: fs.stat,
        });

        await saveLocal(repoRoot, event.sessionId, localTurnState);

        const timestamp = new Date().toISOString();
        const prompt = redact(event.prompt ?? '');

        await recordLocally(repoRoot, event.sessionId, {
            kind: 'turn-start',
            turnId,
            prompt,
            commitBefore,
            timestamp,
        });

        sendEvent(
            buildTurnStartEvent({
                sessionId: event.sessionId,
                branch,
                timestamp,
                turnId,
                prompt,
                commitBefore,
            }),
            repoRoot,
        );
    }

    // -------------------------------------------------------------------------
    // Turn End (stop / post-todo)
    // -------------------------------------------------------------------------

    private async handleTurnEnd(
        repoRoot: string,
        agentType: AgentType,
        event: LifecycleEvent,
    ): Promise<void> {
        await hookLogger.info('turn-end', 'lifecycle', {
            agent: agentType,
            model_session_id: event.sessionId,
        });

        const local = await loadLocal(repoRoot, event.sessionId);

        // Dedup: if this turn was already completed (e.g. Stop + PostToolUse
        // both firing TurnEnd), skip the duplicate.
        if (local?.turnCompleted) {
            await hookLogger.info('turn-end-dedup-skipped', 'lifecycle', {
                agent: agentType,
                model_session_id: event.sessionId,
                turn_id: local.turnId,
            });
            return;
        }

        // If turn_start never fired, synthesize a turn id so turn_end still
        // has a stable pair and the backend receives a matching lifecycle.
        const turnId = local?.turnId ?? `${Date.now()}`;
        const transcriptPath = local?.transcriptPath ?? event.sessionRef ?? '';
        const transcriptOffset = local?.transcriptOffset ?? 0;

        let toolCalls: ToolCall[] = [];
        let filesModified: FileChange[] = [];
        let filesRead: string[] = [];
        let commands: string[] = [];
        let tokenUsage = createEmptyTokenUsage();
        let response = '';

        if (transcriptPath) {
            ({
                toolCalls,
                filesModified,
                filesRead,
                commands,
                tokenUsage,
                response,
            } = await collectTurnTranscriptData({
                transcriptPath,
                transcriptOffset,
                transcriptService,
                hookLogger,
            }));
        }

        const [branch, commitAfter] = await Promise.all([
            getBranchSafe(gitService),
            getHeadSafe(gitService),
        ]);

        if (!local) {
            await hookLogger.warn('turn-end-without-turn-start', 'lifecycle', {
                agent: agentType,
                model_session_id: event.sessionId,
                synthetic_turn_id: turnId,
            });

            sendEvent(
                buildTurnStartEvent({
                    sessionId: event.sessionId,
                    branch,
                    timestamp: new Date().toISOString(),
                    turnId,
                    prompt: redact(''),
                    commitBefore: commitAfter,
                }),
                repoRoot,
            );
        }

        // Mark turn as completed BEFORE sending the event to prevent
        // duplicate turn_end from Stop + PostToolUse(TodoWrite) both firing.
        // Save even for synthetic turns (when local was null) so subsequent
        // TurnEnd calls for the same session are deduped.
        await saveLocal(repoRoot, event.sessionId, {
            turnId,
            transcriptPath,
            transcriptOffset,
            turnCompleted: true,
        });

        const timestamp = new Date().toISOString();
        const redactedResponse = redact(response);
        const redactedCommands = commands.map((command) => redact(command));

        filesModified = filesModified.map((change) => ({
            ...change,
            path: toRepoRelative(repoRoot, change.path),
        }));
        filesRead = filesRead.map((file) => toRepoRelative(repoRoot, file));

        await recordLocally(repoRoot, event.sessionId, {
            kind: 'turn-end',
            turnId,
            response: redactedResponse,
            toolCalls: toTraceToolCalls(repoRoot, toolCalls),
            filesModified,
            filesRead,
            commands: redactedCommands,
            tokenUsage,
            commitAfter,
            timestamp,
        });

        sendEvent(
            buildTurnEndEvent({
                sessionId: event.sessionId,
                branch,
                timestamp,
                turnId,
                response: redactedResponse,
                toolCalls,
                filesModified,
                filesRead,
                commands,
                tokenUsage,
                commitAfter,
            }),
            repoRoot,
        );
    }

    // -------------------------------------------------------------------------
    // Session End
    // -------------------------------------------------------------------------

    private async handleSessionEnd(
        repoRoot: string,
        agentType: AgentType,
        event: LifecycleEvent,
    ): Promise<void> {
        await hookLogger.info('session-end', 'lifecycle', {
            agent: agentType,
            model_session_id: event.sessionId,
        });

        const branch = await getBranchSafe(gitService);
        const timestamp = new Date().toISOString();

        await recordLocally(repoRoot, event.sessionId, {
            kind: 'session-end',
            timestamp,
        });

        sendEvent(
            buildSessionEndEvent({
                sessionId: event.sessionId,
                branch,
                timestamp,
            }),
            repoRoot,
        );

        // Clean up the ephemeral turn state. The durable record stays.
        await removeLocal(repoRoot, event.sessionId);
    }

    // -------------------------------------------------------------------------
    // Subagent Start (pre-task)
    // -------------------------------------------------------------------------

    private async handleSubagentStart(
        repoRoot: string,
        agentType: AgentType,
        event: LifecycleEvent,
    ): Promise<void> {
        await hookLogger.info('subagent-start', 'lifecycle', {
            agent: agentType,
            model_session_id: event.sessionId,
            tool_use_id: event.toolUseId,
            subagent_type: event.subagentType,
            task_description: redact(event.taskDescription ?? '').slice(0, 200),
        });

        if (!event.toolUseId) {
            return;
        }

        const branch = await getBranchSafe(gitService);

        sendEvent(
            buildSubagentStartEvent({
                event,
                branch,
                timestamp: new Date().toISOString(),
            }),
            repoRoot,
        );
    }

    // -------------------------------------------------------------------------
    // Stale Session Cleanup
    // -------------------------------------------------------------------------

    private async cleanupStaleSessions(
        repoRoot: string,
        agentType: AgentType,
    ): Promise<void> {
        const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
        try {
            const stale = await listStaleSessions(repoRoot, STALE_THRESHOLD_MS);
            if (stale.length === 0) {
                return;
            }

            const branch = await getBranchSafe(gitService);

            for (const { sessionId } of stale) {
                await hookLogger.info('stale-session-cleanup', 'lifecycle', {
                    agent: agentType,
                    stale_session_id: sessionId,
                });

                sendEvent(
                    {
                        type: 'session_end',
                        sessionId,
                        branch,
                        timestamp: new Date().toISOString(),
                    },
                    repoRoot,
                );

                await removeLocal(repoRoot, sessionId);
            }
        } catch {
            // Best-effort cleanup — never block the current session
        }
    }

    // -------------------------------------------------------------------------
    // Subagent End (post-task)
    // -------------------------------------------------------------------------

    private async handleSubagentEnd(
        repoRoot: string,
        agentType: AgentType,
        event: LifecycleEvent,
    ): Promise<void> {
        await hookLogger.info('subagent-end', 'lifecycle', {
            agent: agentType,
            model_session_id: event.sessionId,
            tool_use_id: event.toolUseId,
        });

        if (!event.toolUseId) {
            return;
        }

        const branch = await getBranchSafe(gitService);

        sendEvent(
            buildSubagentEndEvent({
                sessionId: event.sessionId,
                branch,
                timestamp: new Date().toISOString(),
                toolUseId: event.toolUseId,
            }),
            repoRoot,
        );
    }
}

export const lifecycleService = new LifecycleService();
