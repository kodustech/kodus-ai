import fs from 'fs/promises';
import path from 'path';
import type { LogLevel, LogComponent, LogEntry } from '../types/session.js';
import { ensureDir, getKodusHome, hashPath } from './kodus-paths.service.js';
import { redactText } from './redaction.service.js';

/**
 * Hook logger — writes under ~/.kodus/logs/<repo-hash>/hooks.jsonl
 * so a session never dirties the repository working tree.
 * String fields are redacted before write so secrets never land on disk.
 */
class HookLoggerService {
    private logPath: string | null = null;

    /**
     * Initialize the logger with a repo root path.
     * Must be called before any log methods.
     */
    async init(repoRoot: string): Promise<void> {
        const key = hashPath(path.resolve(repoRoot));
        const logDir = path.join(getKodusHome(), 'logs', key);
        await ensureDir(logDir);
        this.logPath = path.join(logDir, 'hooks.jsonl');
    }

    async info(
        msg: string,
        component: LogComponent,
        fields?: Record<string, unknown>,
    ): Promise<void> {
        await this.log('INFO', msg, component, fields);
    }

    async warn(
        msg: string,
        component: LogComponent,
        fields?: Record<string, unknown>,
    ): Promise<void> {
        await this.log('WARN', msg, component, fields);
    }

    async error(
        msg: string,
        component: LogComponent,
        fields?: Record<string, unknown>,
    ): Promise<void> {
        await this.log('ERROR', msg, component, fields);
    }

    async debug(
        msg: string,
        component: LogComponent,
        fields?: Record<string, unknown>,
    ): Promise<void> {
        await this.log('DEBUG', msg, component, fields);
    }

    private redactFields(
        fields?: Record<string, unknown>,
    ): Record<string, unknown> | undefined {
        if (!fields) {
            return fields;
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) {
            if (typeof v === 'string') {
                out[k] = redactText(v);
            } else {
                out[k] = v;
            }
        }
        return out;
    }

    private async log(
        level: LogLevel,
        msg: string,
        component: LogComponent,
        fields?: Record<string, unknown>,
    ): Promise<void> {
        if (!this.logPath) {
            return;
        }

        const entry: LogEntry = {
            ...this.redactFields(fields),
            time: new Date().toISOString(),
            level,
            msg,
            component,
        };

        try {
            await fs.appendFile(
                this.logPath,
                JSON.stringify(entry) + '\n',
                'utf-8',
            );
        } catch {
            // Logging must never break the hook flow.
        }
    }
}

export const hookLogger = new HookLoggerService();
