import type { LoggerService } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { diagnosticFields } from './diagnostic-fields';

// The one log format of the Runtime processes: one JSON object per line, with
// the service, the level, the message, ids as fields and the active trace.
// Nest's own Logger instances write through it (the app is created with it),
// so the hub's per-claim lines and the framework lines look the same.
// Fields carry ids only: never a token, a certificate, a key or a canary.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

const stdout: LogSink = (line) => void process.stdout.write(`${line}\n`);

export class RuntimeLogger implements LoggerService {
    constructor(
        private readonly service: string,
        private readonly sink: LogSink = stdout,
        private readonly context?: string,
    ) {}

    child(context: string): RuntimeLogger {
        return new RuntimeLogger(this.service, this.sink, context);
    }

    write(
        level: LogLevel,
        msg: string,
        fields: LogFields = {},
        context = this.context,
    ): void {
        const span = trace.getActiveSpan()?.spanContext();
        try {
            const canonical = {
                at: new Date().toISOString(),
                level,
                service: this.service.slice(0, 512),
                ...(context ? { context: context.slice(0, 512) } : {}),
                msg: msg.slice(0, 512),
                ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
            };
            const line = JSON.stringify({
                ...diagnosticFields(fields),
                ...canonical,
            });
            this.sink(
                Buffer.byteLength(line) <= 16_384
                    ? line
                    : JSON.stringify({ ...canonical, metadataTruncated: true }),
            );
        } catch {
            /* A diagnostic sink must not change workflow execution. */
        }
    }

    info(msg: string, fields?: LogFields) {
        this.write('info', msg, fields);
    }

    // LoggerService (Nest): the last string parameter is the context.
    log(message: unknown, ...rest: unknown[]) {
        this.nest('info', message, rest);
    }
    error(message: unknown, ...rest: unknown[]) {
        this.nest('error', message, rest);
    }
    warn(message: unknown, ...rest: unknown[]) {
        this.nest('warn', message, rest);
    }
    debug(message: unknown, ...rest: unknown[]) {
        this.nest('debug', message, rest);
    }
    verbose(message: unknown, ...rest: unknown[]) {
        this.nest('debug', message, rest);
    }

    private nest(level: LogLevel, message: unknown, rest: unknown[]) {
        const context =
            typeof rest[rest.length - 1] === 'string'
                ? (rest[rest.length - 1] as string)
                : this.context;
        if (level === 'debug') return;
        try {
            if (message instanceof Error) {
                this.write(
                    level,
                    'runtime.operation.failed',
                    { error: message },
                    context,
                );
                return;
            }
            const fields =
                message !== null && typeof message === 'object'
                    ? (message as LogFields)
                    : {};
            let text = typeof message === 'string' ? message : '';
            const value = Object.getOwnPropertyDescriptor(fields, 'msg')?.value;
            if (typeof value === 'string') text = value;
            this.write(level, text || 'runtime.log', fields, context);
        } catch {
            this.write(
                level,
                'runtime.log_refused',
                { reason: 'invalid_metadata' },
                context,
            );
        }
    }
}

/** A logger that drops everything (unit tests). */
export const silentLogger = () => new RuntimeLogger('test', () => undefined);
