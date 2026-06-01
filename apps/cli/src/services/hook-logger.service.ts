import fs from 'fs/promises';
import path from 'path';
import type { LogLevel, LogComponent, LogEntry } from '../types/session.js';

const LOG_FILE = '.kody/logs/hooks.jsonl';

class HookLoggerService {
    private logDir: string | null = null;
    private logPath: string | null = null;

    /**
     * Initialize the logger with a repo root path.
     * Must be called before any log methods.
     */
    async init(repoRoot: string): Promise<void> {
        this.logDir = path.join(repoRoot, '.kody', 'logs');
        this.logPath = path.join(repoRoot, LOG_FILE);
        await fs.mkdir(this.logDir, { recursive: true });
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
            ...fields,
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
