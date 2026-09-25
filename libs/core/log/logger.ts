import { Agent, ClientRequest, IncomingMessage } from 'http';
import { Socket } from 'net';

import { trace } from '@opentelemetry/api';
import pino from 'pino';

/**
 * Structured application logger — ported out of the legacy flow engine's observability
 * module so app code (`libs/*`, `apps/*`) depends on `libs/core` instead of the
 * standalone flow package. Public API is intentionally byte-compatible with the
 * previous `createLogger` from the legacy flow engine:
 *
 *   const logger = createLogger(MyService.name);
 *   logger.error({ message, context, metadata, error });
 *
 * The flow package keeps its own internal copy for its engine; this is the
 * canonical logger for the orchestrator app.
 */

// ---------------------------------------------------------------------------
// Types (logging subset, ported from the flow observability types)
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
    [key: string]: unknown;
}

/**
 * Minimal ExecutionContext interface compatible with NestJS. Avoids a hard
 * dependency on `@nestjs/common` at the logging layer.
 */
export interface ExecutionContext {
    switchToHttp(): {
        getRequest(): { url?: string; [key: string]: unknown };
        getResponse(): unknown;
        getNext(): unknown;
    };
    [key: string]: unknown;
}

export type LogArguments = {
    message: string;
    context: ExecutionContext | string;
    serviceName?: string;
    error?: Error;
    metadata?: Record<string, any>;
};

export interface ObjectLogProcessor {
    process(
        level: LogLevel,
        message: string,
        context?: LogContext,
        error?: Error,
    ): void;
}

export type FunctionLogProcessor = (
    level: LogLevel,
    message: string,
    component: string,
    context?: LogContext,
    error?: Error,
) => void;

type SupportedLogProcessor = ObjectLogProcessor | FunctionLogProcessor;

// ---------------------------------------------------------------------------
// Pino singleton
// ---------------------------------------------------------------------------

let pinoLogger: pino.Logger | null = null;

let globalLogProcessors: SupportedLogProcessor[] = [];
let spanContextProvider:
    (() => { traceId: string; spanId: string } | undefined) | null = null;
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

        try {
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
        } catch (err) {
            // `pino.transport()` throws SYNCHRONOUSLY when its target module
            // can't be resolved — notably 'pino-pretty' inside a webpack bundle
            // (the mcp-manager), where transports run in a worker thread that
            // resolves the target by path. The async `.on('error')` handler
            // above can't catch this — the throw happens before it's attached.
            // A logging-transport failure must NEVER break the app: this was
            // propagating out of the first log() call and crashing MCP
            // integration loading. Fall back to an in-process stdout logger.
            console.error(
                'Pino transport could not be created, falling back to in-process stdout logger:',
                err,
            );
            pinoLogger = pino(baseConfig, pino.destination({ dest: 1 }));
        }
    }
    return pinoLogger;
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

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
    // GitLab PAT header (`PRIVATE-TOKEN`) and webhook secret header.
    'privatetoken',
    'xgitlabtoken',
    // Amazon Bedrock BYOK credentials (normalized: lowercased, separators
    // stripped). These travel under aws* field names inside a credential's
    // `settings` and must be redacted at any log depth.
    'awssecretaccesskey',
    'awsbearertoken',
    'awsaccesskeyid',
    'awssessiontoken',
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

function isSensitiveName(name: string): boolean {
    return SENSITIVE_KEYS.has(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/**
 * Customer content: fields that carry source code or model prompts derived
 * from it. These are NOT secrets — we are authorized to process them, but not
 * to retain them in operational logs, where they sit for the log group's
 * retention period. They are therefore kept out of logs entirely, and replaced
 * by a size marker so the operational signal ("there was content, this big")
 * survives for debugging.
 *
 * Kept separate from SENSITIVE_KEYS on purpose: different policy, different
 * censor, and mixing the two would make "[REDACTED]" ambiguous between
 * "a secret was here" and "customer code was here".
 */
const CONTENT_KEYS = new Set([
    'existingcode',
    'improvedcode',
    'suggestioncontent',
    'llmprompt',
]);

function isContentName(name: string): boolean {
    return CONTENT_KEYS.has(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

const CONTENT_KEY_CACHE = new Map<string, boolean>();

function isContentKey(key: string): boolean {
    let result = CONTENT_KEY_CACHE.get(key);
    if (result === undefined) {
        result = isContentName(key);
        if (CONTENT_KEY_CACHE.size < KEY_SENSITIVITY_CACHE_MAX) {
            CONTENT_KEY_CACHE.set(key, result);
        }
    }
    return result;
}

function describeOmitted(value: any): string {
    // Two invariants, both load-bearing.
    //
    // Never serialize to measure: JSON.stringify on a ~200KB object costs
    // ~0.25ms against ~5ns for String#length, and would defeat the very guard
    // this function implements.
    //
    // Never throw: deepSanitize is exception-free by design — the WeakSet
    // cycle guard, the depth cap and the typed-array marker all exist to keep
    // it so — and callers rely on that. mongodb-exporter.ts:1032 calls it
    // unguarded inside an `async exportLog` fired as `void this.exportLog(...)`
    // (line 1061), so a throw here becomes an unhandled rejection that can take
    // the process down. The value is discarded anyway, so a getter that throws
    // must cost us a vaguer marker, never an exception.
    try {
        if (typeof value === 'string') {
            return `[content omitted: ${formatBytes(value.length)}]`;
        }
        if (ArrayBuffer.isView(value)) {
            return `[content omitted: ${formatBytes(value.byteLength)}]`;
        }
        if (Array.isArray(value)) {
            return `[content omitted: ${value.length} items]`;
        }
    } catch {
        // exotic object: a throwing length/byteLength getter, a hostile Proxy.
    }
    return '[content omitted]';
}

function formatBytes(n: number): string {
    return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;
}

/**
 * UTF-8 byte length, not UTF-16 code units. String#length under-reports by up
 * to 4x on non-ASCII (4096 chars of CJK is 12,288 bytes), and the ceiling we
 * are defending is CloudWatch's, which counts bytes.
 */
function byteLen(s: string): number {
    // Buffer.byteLength is native and beats a JS scan even on ASCII: measured
    // ~0ns against ~12ns for a hand-rolled charCodeAt loop over 4096 chars.
    return Buffer.byteLength(s, 'utf8');
}

// Object keys only. The cache never evicts, so names harvested from string
// content (payload JSON keys, query params) would fill it for good; the
// string scanners call isSensitiveName directly instead.
function isSensitiveKey(key: string): boolean {
    let result = KEY_SENSITIVITY_CACHE.get(key);
    if (result === undefined) {
        result = isSensitiveName(key);
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
 * Strips credentials embedded in a string: URL userinfo, sensitive query or
 * form parameters, raw HTTP header lines and JSON key/value pairs. Key-based
 * redaction in `deepSanitize` can't see these because the secret lives inside
 * one string value — e.g. an AxiosError's `request._header` or `config.data`.
 * Returns the original reference when nothing was redacted.
 */
function sanitizeString(value: string): string {
    return redactEmbeddedSecrets(redactUrlUserinfo(value));
}

function stringifyUnknownError(value: unknown): string {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

// Cheap pre-check so ordinary strings (stacks, messages) skip the regexes.
// Loose on purpose: a false hit only costs the scans below. The gate is
// fail-open, so every name in SENSITIVE_KEYS must match one of these stems —
// a spec walks the set and fails when a new key has no stem here.
const EMBEDDED_SECRET_HINT =
    /auth|cookie|token|secret|passw|key|credential|jwt|connection|ssn|cpf|cvv|card/i;

// Linear patterns (no nested or overlapping quantifiers).
// The optional leading `+`/`-` covers unified-diff lines, which get logged.
const HEADER_LINE_PATTERN =
    /(^|[\r\n])([+-]?[ \t]*)([A-Za-z0-9_.-]{1,100})([ \t]*:[ \t]*)([^\r\n]*)/g;
// The optional `+`/`-` marker mirrors HEADER_LINE_PATTERN for diff lines.
const QUERY_PARAM_PATTERN =
    /(^|[?&;\s])([+-]?)([A-Za-z0-9_.-]{1,100})=([^&#\s"'<>]*)/g;
const JSON_PAIR_PATTERN = /"([^"\\]{1,100})"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;

function redactEmbeddedSecrets(value: string): string {
    if (!EMBEDDED_SECRET_HINT.test(value)) {
        return value;
    }

    const result = value
        .replace(
            HEADER_LINE_PATTERN,
            (match, lineStart, indent, name, separator, headerValue) =>
                isSensitiveName(name) && headerValue
                    ? `${lineStart}${indent}${name}${separator}[REDACTED]`
                    : match,
        )
        .replace(
            QUERY_PARAM_PATTERN,
            (match, prefix, marker, name, paramValue) =>
                isSensitiveName(name) && paramValue
                    ? `${prefix}${marker}${name}=[REDACTED]`
                    : match,
        )
        .replace(JSON_PAIR_PATTERN, (match, name, separator) =>
            isSensitiveName(name) ? `"${name}"${separator}"[REDACTED]"` : match,
        );

    return result === value ? value : result;
}

/**
 * Strips credentials embedded in URL strings using a linear scan.
 * e.g. "mongodb://user:secret@host/db" → "mongodb://user:[REDACTED]@host/db"
 */
function redactUrlUserinfo(value: string): string {
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
 * still overflow.
 */
const DEEP_SANITIZE_MAX_DEPTH = 24;

/**
 * Size bounds — the siblings of DEEP_SANITIZE_MAX_DEPTH.
 *
 * Depth-bounding alone does not stop a single wide value: a 260KB string in a
 * shallow object still produces a 260KB log line, which exceeds CloudWatch's
 * 256KB per-event limit and arrives TRUNCATED — invalid JSON that no parser
 * can read. These bounds catch the class that no denylist covers: the field
 * nobody thought to name.
 */
const DEEP_SANITIZE_MAX_STRING = 4096;
const DEEP_SANITIZE_MAX_ARRAY = 50;

/**
 * Aggregate budget, in UTF-8 bytes.
 *
 * Per-value caps do NOT bound the line: 100 fields sitting exactly AT the
 * 4096-char cap, none of them content-named, serialize to ~410KB and still
 * blow through CloudWatch's 256KB per-event ceiling — the very symptom this
 * guard exists to stop. Nothing caps object key count either.
 *
 * So the recursion carries a running byte total and, once it is spent, every
 * remaining value becomes a marker. 192KB leaves ~64KB of headroom for the
 * JSON structure pino adds around these values.
 */
const CLOUDWATCH_MAX_EVENT = 256 * 1024;
/**
 * The emitted line carries the SAME sanitized object more than once:
 * buildLogObject spreads safeMetadata at the top level (line ~927) and stores
 * it again under `metadata` (line ~930), and handleLog adds `err` (line ~826),
 * which the pino serializer sanitizes with its own independent budget. So a
 * per-call budget of B produces a line of up to 3B, and budgeting 192KB per
 * call yields a ~576KB event — past the ceiling it was meant to defend.
 */
const MAX_LINE_COPIES = 3;
const DEEP_SANITIZE_MAX_TOTAL = Math.floor(
    (CLOUDWATCH_MAX_EVENT * 0.75) / MAX_LINE_COPIES,
);
const BUDGET_SPENT_MARKER = '[budget spent]';

/**
 * How many keys may still be emitted after the budget is spent, so a small
 * trailing key (`createdAt`, `tu`) is never evicted by position alone.
 */
const KEY_TAIL_ALLOWANCE = 100;

/** Bounds the shallow-object case in isCheapValue. */
const CHEAP_OBJECT_MAX_KEYS = 12;

/**
 * Cheap enough to carry past an exhausted budget without measuring it: a
 * scalar, a short string, a Date, or a flat object of those. The flat-object
 * case exists for values like `tu` ({ credits: n }), which credits metering
 * reads and which `startSpan` appends last — a scalar-only rule would have
 * collapsed it to a marker for its position alone.
 */
function isCheapValue(v: any): boolean {
    const type = typeof v;
    if (v === null || type === 'number' || type === 'boolean') return true;
    if (type === 'string') return v.length <= 256;
    if (type !== 'object') return false;
    if (v instanceof Date) return true;
    if (Array.isArray(v)) return false;
    try {
        const ks = Object.keys(v);
        if (ks.length > CHEAP_OBJECT_MAX_KEYS) return false;
        for (const k of ks) {
            const inner = v[k];
            const it = typeof inner;
            if (inner === null || it === 'number' || it === 'boolean') continue;
            if (it === 'string' && inner.length <= 256) continue;
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * JSON cost of a non-string leaf plus its punctuation. Deliberately generous:
 * a float serializes to ~18 characters ("48.148148271000004"), so charging 8
 * let a numeric tree overshoot the budget by ~2x.
 */
const PRIMITIVE_BUDGET_COST = 20;

interface SanitizeBudget {
    used: number;
}

/**
 * Deep-sanitizes an object, redacting sensitive keys at any depth.
 * Also strips URL-embedded credentials from string values.
 * Uses structural sharing: returns the original reference when nothing changed,
 * so clean metadata incurs zero allocation overhead.
 *
 * Depth-bounded: stops recursing past `DEEP_SANITIZE_MAX_DEPTH` and
 * returns a `[Max-Depth]` marker.
 */
function isRedirectableRequest(obj: any): boolean {
    return (
        '_currentRequest' in obj &&
        '_options' in obj &&
        Array.isArray(obj._requestBodyBuffers)
    );
}

function deepSanitize(
    obj: any,
    seen?: WeakSet<object>,
    depth = 0,
    budget: SanitizeBudget = { used: 0 },
): any {
    if (budget.used >= DEEP_SANITIZE_MAX_TOTAL) {
        return BUDGET_SPENT_MARKER;
    }

    if (obj === null || typeof obj !== 'object') {
        if (typeof obj === 'string') {
            // Truncate BEFORE scanning. The scanners are O(n) over the whole
            // string, so a 260KB value costs 260KB of scanning to then throw
            // 256KB away. Cutting first also means a secret living in the
            // discarded tail is never read, let alone emitted.
            if (obj.length > DEEP_SANITIZE_MAX_STRING) {
                const head = sanitizeString(obj.slice(0, DEEP_SANITIZE_MAX_STRING));
                budget.used += byteLen(head);
                return `${head}…[truncated: ${formatBytes(byteLen(obj))} total]`;
            }
            const sanitized = sanitizeString(obj);
            budget.used += byteLen(sanitized);
            return sanitized !== obj ? sanitized : obj;
        }
        // Numbers and booleans are not free: a tree of them (scores, embeddings)
        // paid only for its root key and serialized to 721KB in testing.
        budget.used += PRIMITIVE_BUDGET_COST;
        return obj;
    }

    // A Buffer (or any typed-array view) is walked index by index, comes out
    // unchanged, and pino then serializes it via toJSON(): a 1 MB buffer costs
    // ~131 ms here, expands to ~3 MB of JSON, and the bytes stay recoverable.
    // This is also where an axios request body lands on a timeout
    // (`_requestBodyBuffers`).
    if (ArrayBuffer.isView(obj)) {
        return `[Binary ${obj.byteLength} bytes]`;
    }

    // Live Node HTTP objects (an AxiosError's `request`, sockets, agents) carry
    // the raw request head with credentials and TLS session buffers. Nothing
    // in them is worth logging, so don't walk them.
    if (obj instanceof ClientRequest) {
        return '[ClientRequest]';
    }
    // follow-redirects' RedirectableRequest wraps the native request and is
    // what axios attaches as `err.request` on timeouts and connection errors.
    // It is a Writable, not a ClientRequest, and its `_options` carries the
    // headers and the `auth` option ("user:password") under non-sensitive keys.
    if (isRedirectableRequest(obj)) {
        return '[RedirectableRequest]';
    }
    if (obj instanceof IncomingMessage) {
        return '[IncomingMessage]';
    }
    if (obj instanceof Socket) {
        return '[Socket]';
    }
    if (obj instanceof Agent) {
        return '[Agent]';
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

    let arrayLength = -1;
    try {
        if (Array.isArray(obj)) arrayLength = obj.length;
    } catch {
        return '[unreadable]';
    }

    if (arrayLength >= 0) {
        // Index loop, not `for…of obj.slice(...)`: slice() allocates a copy of
        // every array, including the short clean ones that structural sharing
        // exists to leave untouched.
        const capped = arrayLength > DEEP_SANITIZE_MAX_ARRAY;
        const limit = capped ? DEEP_SANITIZE_MAX_ARRAY : arrayLength;
        let changed = capped;
        const out: any[] = [];
        for (let i = 0; i < limit; i++) {
            if (budget.used >= DEEP_SANITIZE_MAX_TOTAL) {
                out.push(`[+${arrayLength - i} more items omitted]`);
                changed = true;
                break;
            }
            let item: any;
            try {
                item = obj[i];
            } catch {
                out.push('[unreadable]');
                changed = true;
                continue;
            }
            const sanitized = deepSanitize(item, refs, depth + 1, budget);
            out.push(sanitized);
            if (sanitized !== item) changed = true;
        }
        if (capped && out.length === DEEP_SANITIZE_MAX_ARRAY) {
            out.push(`[+${arrayLength - DEEP_SANITIZE_MAX_ARRAY} more items omitted]`);
        }
        // Return original array reference if nothing was redacted.
        return changed ? out : obj;
    }

    let changed = false;
    let tailEmitted = 0;
    const out: Record<string, any> = {};
    let keys: string[];
    try {
        keys = Object.keys(obj);
    } catch {
        return '[unreadable]';
    }
    for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        // Once the budget is spent, keep going but emit only cheap values.
        //
        // Breaking outright made survival depend on key ORDER, and the keys
        // that matter come last: `createdAt` is the final key of the exporter's
        // log document and the collection's TTL index is built on it, so
        // dropping it produced a document that NEVER EXPIRES — the opposite of
        // the retention this guard exists to enforce. `startSpan` appends `tu`
        // last, so credits metering silently undercounted for the same reason.
        //
        // A scalar costs ~20 bytes, so carrying the tail is cheap and only the
        // heavy values collapse. KEY_TAIL_ALLOWANCE still bounds an object with
        // tens of thousands of keys.
        if (budget.used >= DEEP_SANITIZE_MAX_TOTAL) {
            if (tailEmitted >= KEY_TAIL_ALLOWANCE) {
                out['…'] = `[+${keys.length - k} more keys omitted]`;
                changed = true;
                break;
            }
            tailEmitted++;
            changed = true;
            let tailRaw: any;
            try {
                tailRaw = obj[key];
            } catch {
                out[key] = '[unreadable]';
                continue;
            }
            if (isSensitiveKey(key)) out[key] = '[REDACTED]';
            else if (isContentKey(key)) out[key] = describeOmitted(tailRaw);
            else if (isCheapValue(tailRaw)) out[key] = tailRaw;
            else out[key] = BUDGET_SPENT_MARKER;
            continue;
        }
        // Charge the key in EVERY branch. Charging it only on the ordinary
        // path let thousands of keys that normalize into one SENSITIVE_KEYS /
        // CONTENT_KEYS entry (`p-assword`, `P.ASSWORD`, …) emit ~25 bytes each
        // with budget.used still at 0.
        budget.used += byteLen(key) + 4;

        if (isSensitiveKey(key)) {
            out[key] = '[REDACTED]';
            budget.used += 12;
            changed = true;
            continue;
        }

        // Read the property under guard. A getter can throw — the repo's own
        // notes record that shape (mongodb-exporter.ts:1450-1454, "getters that
        // throw") — and the read happens HERE, before any try/catch inside a
        // helper could cover it. deepSanitize is relied on to be exception-free
        // (mongodb-exporter.ts:1032 calls it unguarded inside an `async
        // exportLog` fired as `void this.exportLog(...)` at line 1061, so a
        // throw is an unhandled rejection that ends the process), so a hostile
        // value must cost us a marker, never an exception.
        let raw: any;
        try {
            raw = obj[key];
        } catch {
            out[key] = '[unreadable]';
            changed = true;
            continue;
        }

        if (isContentKey(key)) {
            const marker = describeOmitted(raw);
            out[key] = marker;
            budget.used += byteLen(marker);
            changed = true;
        } else {
            const val = deepSanitize(raw, refs, depth + 1, budget);
            out[key] = val;
            if (val !== raw) changed = true;
        }
    }
    // Return original object reference if nothing was redacted.
    return changed ? out : obj;
}

// ---------------------------------------------------------------------------
// SimpleLogger
// ---------------------------------------------------------------------------

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
                        fallbackPayload.errorMessage =
                            typeof error === 'string'
                                ? error
                                : (error as Error)?.message;
                    }
                    const loggerErrAsError = loggerErr as Error | undefined;
                    fallbackPayload.loggerErrorName = loggerErrAsError?.name;
                    fallbackPayload.loggerErrorMessage =
                        loggerErrAsError?.message;

                    console.error(JSON.stringify(fallbackPayload));
                } catch {
                    console.error(
                        '[logger:fallback-failed] level=' +
                            level +
                            ' service=' +
                            effectiveServiceName,
                    );
                }
            }
        }

        let safeProcessorMetadata: Record<string, unknown>;
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
            } catch {
                // A failing processor must never break the caller's log call,
                // and must not be reported through the logger itself (that
                // would re-enter this same loop). Skip it and keep going.
            }
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
            // Callers pass `error: err.message` too; a string has no .message,
            // and sanitizeString(undefined) used to throw and drop the cause.
            const raw = error as unknown;
            const message =
                typeof raw === 'string'
                    ? raw
                    : typeof error.message === 'string'
                      ? error.message
                      : stringifyUnknownError(raw);
            logObject.error = {
                message: sanitizeString(message),
                stack:
                    typeof raw !== 'string' && typeof error.stack === 'string'
                        ? sanitizeString(error.stack)
                        : undefined,
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
export {
    deepSanitize,
    isSensitiveKey,
    KEY_SENSITIVITY_CACHE,
    sanitizeString,
    SENSITIVE_KEYS,
};

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
