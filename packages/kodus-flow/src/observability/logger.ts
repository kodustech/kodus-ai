import { trace } from '@opentelemetry/api';
import pino from 'pino';
import {
    LogArguments,
    LogProcessor as ObjectLogProcessor,
    ExecutionContext,
} from './types.js';
import {
    LogLevel,
    LogProcessor as FunctionLogProcessor,
} from '@/core/types/allTypes.js';

let pinoLogger: pino.Logger | null = null;
type SupportedLogProcessor = ObjectLogProcessor | FunctionLogProcessor;

let globalLogProcessors: SupportedLogProcessor[] = [];
let spanContextProvider:
    | (() => { traceId: string; spanId: string } | undefined)
    | null = null;
let observabilityContextProvider:
    | (() =>
          | {
                correlationId?: string;
                tenantId?: string;
                sessionId?: string;
            }
          | undefined)
    | null = null;

function getPinoLogger(): pino.Logger {
    if (!pinoLogger) {
        const shouldPrettyPrint =
            (process.env.API_LOG_PRETTY || 'false') === 'true';
        const isProduction =
            (process.env.API_NODE_ENV || 'production') === 'production';

        const baseConfig: pino.LoggerOptions = {
            level: process.env.API_LOG_LEVEL || 'info',
            formatters: {
                level: (label) => ({ level: label }),
            },
            serializers: {
                // Custom err serializer: run pino's stdSerializer to flatten the
                // Error, then deepSanitize so nested HTTPError shapes (got/axios
                // throw with err.request.headers.authorization, err.options.headers,
                // err.response.headers.set-cookie, etc.) are redacted by key name
                // at any depth — no need to enumerate every possible path below.
                error: (err: any) => deepSanitize(pino.stdSerializers.err(err)),
                err: (err: any) => deepSanitize(pino.stdSerializers.err(err)),
                req: pino.stdSerializers.req,
                res: pino.stdSerializers.res,
            },
            redact: {
                paths: [
                    // depth 0
                    'password',
                    'token',
                    'secret',
                    'apiKey',
                    'apikey',
                    'api_key',
                    'authorization',
                    'cookie',
                    'accessToken',
                    'refreshToken',
                    'clientSecret',
                    'privateKey',
                    'bearerToken',
                    'jwt',
                    'credential',
                    'connectionString',
                    // depth 1
                    '*.password',
                    '*.token',
                    '*.secret',
                    '*.apiKey',
                    '*.apikey',
                    '*.api_key',
                    '*.authorization',
                    '*.cookie',
                    '*.accessToken',
                    '*.refreshToken',
                    '*.clientSecret',
                    '*.privateKey',
                    '*.bearerToken',
                    '*.jwt',
                    '*.credential',
                    '*.connectionString',
                    // depth 2
                    '*.*.password',
                    '*.*.token',
                    '*.*.secret',
                    '*.*.apiKey',
                    '*.*.authorization',
                    '*.*.cookie',
                    '*.*.accessToken',
                    '*.*.refreshToken',
                    '*.*.clientSecret',
                    '*.*.privateKey',
                    '*.*.jwt',
                    '*.*.credential',
                    '*.*.connectionString',
                    // HTTP req/res
                    'req.headers.authorization',
                    'req.headers["x-api-key"]',
                    'req.headers.cookie',
                    'res.headers["set-cookie"]',
                    // Intermediate wildcards (`*.headers.X`, `*.*.headers.X`,
                    // `*.*.*.headers.X`) were intentionally removed: they
                    // crashed pino-redact whenever the log payload carried
                    // an `undici` Response in its tree (issue #1105). The
                    // wildcard traversal touches getter-defined properties
                    // on Response (e.g. `.type`) whose internal state may
                    // be invalid after the body is consumed or aborted,
                    // raising a TypeError that escaped this logger.
                    //
                    // `deepSanitize` below (key-based, normalizes case +
                    // punctuation) provides equivalent or stronger
                    // redaction for `authorization` / `cookie` /
                    // `set-cookie` / `x-api-key` / `proxy-authorization`
                    // at arbitrary depth, so dropping the wildcards is
                    // not a coverage loss — it removes redundant work
                    // that was the actual crash site.
                ],
                censor: '[REDACTED]',
            },
            timestamp: pino.stdTimeFunctions.isoTime,
            base: {
                pid: process.pid,
                hostname: undefined,
            },
        };

        let transport;
        if (isProduction && !shouldPrettyPrint) {
            // Production JSON logging to stdout
            transport = pino.transport({
                targets: [
                    {
                        target: 'pino/file',
                        options: {
                            destination: 1, // stdout
                            mkdir: false,
                        },
                        level: process.env.API_LOG_LEVEL || 'info',
                    },
                ],
            });
        } else {
            // Development pretty-printed logging
            transport = pino.transport({
                targets: [
                    {
                        target: 'pino-pretty',
                        options: {
                            colorize: true,
                            translateTime: 'SYS:standard',
                            ignore: 'pid,hostname,environment,metadata,traceId,spanId,correlationId,tenantId,sessionId',
                            levelFirst: true,
                            errorProps: 'message,stack',
                            messageFormat:
                                'SYS:[{serviceName}] {level} - {context} - {msg}',
                        },
                        level: process.env.API_LOG_LEVEL || 'info',
                    },
                ],
            });
        }

        let transportFailed = false;
        transport.on('error', (err) => {
            if (transportFailed) return;
            transportFailed = true;
            console.error(
                'Pino transport worker died, falling back to in-process stdout logger:',
                err,
            );
            // Worker thread is gone — rebuild the singleton with an in-process
            // destination so subsequent getPinoLogger() calls return a healthy
            // logger that can't die the same way.
            pinoLogger = pino(baseConfig, pino.destination({ dest: 1 }));
        });

        pinoLogger = pino(baseConfig, transport);
    }
    return pinoLogger;
}

const SENSITIVE_KEYS = new Set([
    'password',
    'token',
    'secret',
    'apikey',
    'api_key',
    'authorization',
    'proxyauthorization',
    'cookie',
    'setcookie',
    'xapikey',
    'xauthtoken',
    'accesstoken',
    'refreshtoken',
    'clientsecret',
    'privatekey',
    'bearertoken',
    'jwt',
    'credential',
    'connectionstring',
    'ssn',
    'cpf',
    'cvv',
    'creditcard',
]);

// Cache key normalization — bounded to avoid memory growth in long-running processes.
const KEY_SENSITIVITY_CACHE = new Map<string, boolean>();
const KEY_SENSITIVITY_CACHE_MAX = 512;

function isSensitiveKey(key: string): boolean {
    let result = KEY_SENSITIVITY_CACHE.get(key);
    if (result === undefined) {
        result = SENSITIVE_KEYS.has(
            key.toLowerCase().replace(/[^a-z0-9]/g, ''),
        );
        if (KEY_SENSITIVITY_CACHE.size < KEY_SENSITIVITY_CACHE_MAX) {
            KEY_SENSITIVITY_CACHE.set(key, result);
        }
    }
    return result;
}

function isAsciiAlpha(char: string | undefined): boolean {
    return !!char && /[A-Za-z]/.test(char);
}

function isSchemeChar(char: string | undefined): boolean {
    return !!char && /[A-Za-z0-9+\-.]/.test(char);
}

function isAuthorityTerminator(char: string | undefined): boolean {
    return (
        char === undefined ||
        char === '/' ||
        char === '?' ||
        char === '#' ||
        /\s/.test(char)
    );
}

/**
 * Strips credentials embedded in URL strings using a linear scan.
 * e.g. "mongodb://user:secret@host/db" → "mongodb://user:[REDACTED]@host/db"
 */
function sanitizeString(value: string): string {
    let searchFrom = 0;
    let lastCommittedIndex = 0;
    let result = '';

    while (searchFrom < value.length) {
        const schemeSeparatorIndex = value.indexOf('://', searchFrom);

        if (schemeSeparatorIndex === -1) {
            break;
        }

        let schemeStart = schemeSeparatorIndex - 1;
        while (schemeStart >= 0 && isSchemeChar(value[schemeStart])) {
            schemeStart--;
        }
        schemeStart += 1;

        if (!isAsciiAlpha(value[schemeStart])) {
            searchFrom = schemeSeparatorIndex + 3;
            continue;
        }

        const authorityStart = schemeSeparatorIndex + 3;
        let authorityEnd = authorityStart;
        while (
            authorityEnd < value.length &&
            !isAuthorityTerminator(value[authorityEnd])
        ) {
            authorityEnd++;
        }

        let atIndex = -1;
        let colonIndex = -1;
        for (let index = authorityStart; index < authorityEnd; index++) {
            const char = value[index];
            if (char === '@') {
                atIndex = index;
                break;
            }
            if (char === ':') {
                colonIndex = index;
            }
        }

        if (atIndex === -1 || colonIndex === -1 || colonIndex > atIndex) {
            searchFrom = authorityEnd;
            continue;
        }

        result += value.slice(lastCommittedIndex, colonIndex + 1);
        result += '[REDACTED]';
        lastCommittedIndex = atIndex;
        searchFrom = authorityEnd;
    }

    if (lastCommittedIndex === 0) {
        return value;
    }

    result += value.slice(lastCommittedIndex);
    return result;
}

/**
 * Hard cap on recursion depth for `deepSanitize`. The default V8 stack
 * holds ~10k frames before throwing RangeError; we trim well below that
 * because legitimate log payloads never need anywhere near this depth.
 *
 * Why this matters: an AxiosError carries the full Node HTTP agent chain
 * (`err.request.agent.sockets[host][0]._httpMessage.agent.sockets...`),
 * and in long-running workers under load that graph can reach
 * thousands of levels. The WeakSet cycle guard below catches cycles but
 * does NOT bound depth — so a non-cyclic but deeply-nested object would
 * still overflow. In production this manifested as every per-file fetch
 * failure on the AzureReposService falling back to the safety-net
 * `console.error` path with `loggerErrorName: "RangeError"`, losing
 * structured info AND burning CPU on the failed serialization attempts.
 */
const DEEP_SANITIZE_MAX_DEPTH = 24;

/**
 * Deep-sanitizes an object, redacting sensitive keys at any depth.
 * Also strips URL-embedded credentials from string values.
 * Uses structural sharing: returns the original reference when nothing changed,
 * so clean metadata incurs zero allocation overhead.
 *
 * Depth-bounded: stops recursing past `DEEP_SANITIZE_MAX_DEPTH` and
 * returns a `[Max-Depth]` marker. This is the difference between
 * "lost log line" and "truncated-but-present log line" when something
 * upstream hands us a Node HTTP agent / AxiosError graph.
 */
function deepSanitize(obj: any, seen?: WeakSet<object>, depth = 0): any {
    if (obj === null || typeof obj !== 'object') {
        if (typeof obj === 'string') {
            const sanitized = sanitizeString(obj);
            return sanitized !== obj ? sanitized : obj;
        }
        return obj;
    }

    if (
        typeof (globalThis as any).Response === 'function' &&
        obj instanceof (globalThis as any).Response
    ) {
        return '[Response]';
    }
    if (
        typeof (globalThis as any).Request === 'function' &&
        obj instanceof (globalThis as any).Request
    ) {
        return '[Request]';
    }

    if (depth >= DEEP_SANITIZE_MAX_DEPTH) {
        return '[Max-Depth]';
    }

    // Lazily create WeakSet only when we actually recurse into a nested object.
    const refs = seen ?? new WeakSet();
    if (refs.has(obj)) return '[Circular]';
    refs.add(obj);

    if (Array.isArray(obj)) {
        let changed = false;
        const out: any[] = [];
        for (const item of obj) {
            const sanitized = deepSanitize(item, refs, depth + 1);
            out.push(sanitized);
            if (sanitized !== item) changed = true;
        }
        // Return original array reference if nothing was redacted.
        return changed ? out : obj;
    }

    let changed = false;
    const out: Record<string, any> = {};
    for (const key of Object.keys(obj)) {
        if (isSensitiveKey(key)) {
            out[key] = '[REDACTED]';
            changed = true;
        } else {
            const val = deepSanitize(obj[key], refs, depth + 1);
            out[key] = val;
            if (val !== obj[key]) changed = true;
        }
    }
    // Return original object reference if nothing was redacted.
    return changed ? out : obj;
}

export class SimpleLogger {
    private defaultServiceName: string;

    constructor(serviceName: string) {
        this.defaultServiceName = serviceName;
    }

    public log(args: LogArguments) {
        this.handleLog('info', args);
    }

    public error(args: LogArguments) {
        this.handleLog('error', args);
    }

    public warn(args: LogArguments) {
        this.handleLog('warn', args);
    }

    public debug(args: LogArguments) {
        this.handleLog('debug', args);
    }

    private handleLog(
        level: LogLevel,
        { message, context, serviceName, error, metadata = {} }: LogArguments,
    ) {
        if (this.shouldSkipLog(context)) {
            return;
        }

        const effectiveServiceName = serviceName || this.defaultServiceName;
        const contextStr = this.extractContextInfo(context);
        const baseLogger = getPinoLogger();

        // #1105: pino write must never propagate to the caller.
        if (baseLogger.isLevelEnabled(level)) {
            try {
                const childLogger = baseLogger.child({
                    serviceName: effectiveServiceName,
                    context: contextStr,
                });

                const logObject = this.buildLogObject(
                    effectiveServiceName,
                    metadata,
                    error,
                );

                if (error) {
                    childLogger[level]({ ...logObject, err: error }, message);
                } else {
                    childLogger[level](logObject, message);
                }
            } catch (loggerErr) {
                try {
                    const fallbackPayload: Record<string, unknown> = {
                        level,
                        message,
                        serviceName: effectiveServiceName,
                        context: contextStr,
                        loggerFallback: true,
                    };
                    if (error) {
                        fallbackPayload.errorName = (error as Error)?.name;
                        fallbackPayload.errorMessage = (
                            error as Error
                        )?.message;
                    }
                    const loggerErrAsError = loggerErr as Error | undefined;
                    fallbackPayload.loggerErrorName = loggerErrAsError?.name;
                    fallbackPayload.loggerErrorMessage =
                        loggerErrAsError?.message;
                    // eslint-disable-next-line no-console
                    console.error(JSON.stringify(fallbackPayload));
                } catch {
                    // eslint-disable-next-line no-console
                    console.error(
                        '[logger:fallback-failed] level=' +
                            level +
                            ' service=' +
                            effectiveServiceName,
                    );
                }
            }
        }

        let safeProcessorMetadata: Record<string, unknown> = {};
        try {
            safeProcessorMetadata = deepSanitize({
                ...metadata,
                component: effectiveServiceName,
            });
        } catch {
            safeProcessorMetadata = {
                component: effectiveServiceName,
                sanitizationFailed: true,
            };
        }
        for (const processor of globalLogProcessors) {
            try {
                if (typeof processor === 'function') {
                    processor(
                        level,
                        message,
                        effectiveServiceName,
                        safeProcessorMetadata,
                        error,
                    );
                    continue;
                }

                processor.process(level, message, safeProcessorMetadata, error);
            } catch {}
        }
    }

    private extractContextInfo(
        context: ExecutionContext | string | undefined,
    ): string {
        if (!context) return 'unknown';
        if (typeof context === 'string') return context;
        try {
            const request = context.switchToHttp().getRequest();
            return request.url || 'unknown';
        } catch {
            return 'unknown';
        }
    }

    private shouldSkipLog(context: ExecutionContext | string | undefined) {
        return (
            typeof context === 'undefined' ||
            (typeof context === 'string' &&
                ['RouterExplorer', 'RoutesResolver'].includes(context))
        );
    }

    private buildLogObject(
        serviceName: string,
        metadata: Record<string, any>,
        error?: Error,
    ) {
        const safeMetadata = deepSanitize(metadata);
        // User metadata spread FIRST so system fields always win and
        // cannot be poisoned by caller-controlled metadata keys.
        const logObject: Record<string, any> = {
            ...safeMetadata,
            environment: process.env.API_NODE_ENV || 'unknown',
            serviceName,
            metadata: safeMetadata,
            ...this.getTraceContext(),
            ...this.getObservabilityContext(),
        };

        if (error) {
            logObject.error = {
                message: sanitizeString(error.message),
                stack: error.stack ? sanitizeString(error.stack) : undefined,
            };
        }

        return logObject;
    }

    private getTraceContext() {
        if (spanContextProvider) {
            const sc = spanContextProvider();
            if (sc) return sc;
        }

        const currentSpan = trace.getActiveSpan();
        if (!currentSpan) {
            return { traceId: null, spanId: null };
        }

        const ctx = currentSpan.spanContext();
        return {
            traceId: ctx.traceId,
            spanId: ctx.spanId,
        };
    }

    private getObservabilityContext() {
        if (observabilityContextProvider) {
            return observabilityContextProvider() || {};
        }
        return {};
    }
}

/** Exported for testing only. */
export { deepSanitize, isSensitiveKey, sanitizeString };

export function createLogger(component: string): SimpleLogger {
    return new SimpleLogger(component);
}

export function addLogProcessor(processor: SupportedLogProcessor): void {
    globalLogProcessors.push(processor);
}

export function removeLogProcessor(processor: SupportedLogProcessor): void {
    const index = globalLogProcessors.indexOf(processor);
    if (index > -1) {
        globalLogProcessors.splice(index, 1);
    }
}

export function clearLogProcessors(): void {
    globalLogProcessors = [];
}

export function setGlobalLogLevel(level: LogLevel | string): void {
    getPinoLogger().level = level as any;
}

export function setSpanContextProvider(
    provider: (() => { traceId: string; spanId: string } | undefined) | null,
): void {
    spanContextProvider = provider;
}

export function setObservabilityContextProvider(
    provider:
        | (() =>
              | {
                    correlationId?: string;
                    tenantId?: string;
                    sessionId?: string;
                }
              | undefined)
        | null,
): void {
    observabilityContextProvider = provider;
}
