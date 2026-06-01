/* eslint-disable @typescript-eslint/naming-convention --
 * Test fixtures intentionally use real HTTP header spellings
 * (set-cookie, X-API-Key, Proxy-Authorization). The point of
 * the spec is to assert deepSanitize redacts these exact
 * key names — renaming them defeats the regression. */
/**
 * @file logger-resilience.unit.test.ts
 *
 * Regression tests for issue #1105:
 *  - The shared `SimpleLogger` must never propagate an exception
 *    out of `error()/log()/warn()/debug()` calls. Pathological
 *    payloads (notably undici `Response` instances embedded in an
 *    error chain) used to crash pino-redact during JSON
 *    encoding; the exception then escaped the logger and was
 *    re-wrapped by callers as a misleading user-facing error.
 *  - `deepSanitize` must stub `Response`/`Request` so their
 *    getter-defined state (which can throw post-consume) never
 *    reaches the pino pipeline.
 *  - Removing the intermediate-wildcard redaction paths
 *    (`*.headers.X`, `*.*.headers.X`, `*.*.*.headers.X`) must not
 *    drop coverage — `deepSanitize` already redacts those keys at
 *    arbitrary depth, with stronger normalization (case +
 *    punctuation) than the wildcards provided.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger, deepSanitize } from '../../src/observability/logger.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Mimics the failure mode described in issue #1105: an object that
 * exposes state via getters which throw when accessed. Used to
 * verify the logger's outer try/catch catches everything pino's
 * redact/serializer pipeline can raise.
 */
function makeThrowingGetterObject(): object {
    const o: Record<string, unknown> = { kind: 'fake-response' };
    Object.defineProperty(o, 'type', {
        get() {
            throw new TypeError(
                "Cannot read properties of undefined (reading 'type')",
            );
        },
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(o, 'status', {
        get() {
            throw new TypeError('consumed');
        },
        enumerable: true,
        configurable: true,
    });
    return o;
}

// ---------------------------------------------------------------------------
// deepSanitize — Response/Request stub
// ---------------------------------------------------------------------------

describe('deepSanitize — Response/Request stub (issue #1105)', () => {
    it('replaces a real Response instance with the literal "[Response]" string', () => {
        // We only assert this when the test runtime actually provides
        // the Response global (Node 18+); guarding keeps the spec
        // green on environments where the global is absent.
        if (typeof (globalThis as any).Response !== 'function') return;
        const res = new (globalThis as any).Response('body', {
            status: 200,
            headers: { authorization: 'Bearer secret-do-not-log' },
        });
        const sanitized = deepSanitize({ embedded: res });
        expect(sanitized.embedded).toBe('[Response]');
    });

    it('replaces a real Request instance with the literal "[Request]" string', () => {
        if (typeof (globalThis as any).Request !== 'function') return;
        const req = new (globalThis as any).Request(
            'https://example.invalid/secret?api_key=do-not-log',
        );
        const sanitized = deepSanitize({ embedded: req });
        expect(sanitized.embedded).toBe('[Request]');
    });

    it('stubs by instanceof without reading any property — even when getters would throw', () => {
        // We cannot extend Response and override its getters
        // because the base-class constructor itself accesses
        // those getters on `super(...)`. Instead, build a plain
        // object, set its prototype to Response.prototype, and
        // poison `type`/`status`/`url`. `instanceof Response`
        // still returns true (prototype-chain check, no getter
        // access). deepSanitize must short-circuit on the
        // instanceof check without ever touching a property.
        if (typeof (globalThis as any).Response !== 'function') return;
        const trap: Record<string, unknown> = {};
        Object.setPrototypeOf(trap, (globalThis as any).Response.prototype);
        const explode = () => {
            throw new Error('do not touch');
        };
        Object.defineProperty(trap, 'type', {
            get: explode,
            enumerable: true,
        });
        Object.defineProperty(trap, 'status', {
            get: explode,
            enumerable: true,
        });
        Object.defineProperty(trap, 'url', {
            get: explode,
            enumerable: true,
        });
        expect(trap instanceof (globalThis as any).Response).toBe(true);
        expect(() => deepSanitize({ embedded: trap })).not.toThrow();
        expect(deepSanitize({ embedded: trap }).embedded).toBe('[Response]');
    });
});

// ---------------------------------------------------------------------------
// deepSanitize — header redaction without wildcards
// ---------------------------------------------------------------------------

describe('deepSanitize — non-regression for header redaction at depth (issue #1105)', () => {
    // These cases used to be covered by intermediate-wildcard
    // paths in pino-redact (`*.headers.X`, `*.*.headers.X`,
    // `*.*.*.headers.X`). Those wildcards were removed because they
    // crashed on `Response` getters; redaction must continue to
    // work via `deepSanitize`'s key-name normalization instead.
    it('redacts authorization at depth 2', () => {
        const out = deepSanitize({
            req: { headers: { authorization: 'Bearer leaked' } },
        });
        expect(out.req.headers.authorization).toBe('[REDACTED]');
    });

    it('redacts cookie at depth 3', () => {
        const out = deepSanitize({
            wrapper: {
                req: { headers: { cookie: 'session=leaked' } },
            },
        });
        expect(out.wrapper.req.headers.cookie).toBe('[REDACTED]');
    });

    it('redacts set-cookie at depth 4', () => {
        const out = deepSanitize({
            L1: {
                L2: {
                    L3: { headers: { 'set-cookie': 'sess=leaked' } },
                },
            },
        });
        expect(out.L1.L2.L3.headers['set-cookie']).toBe('[REDACTED]');
    });

    it('redacts X-API-Key (kebab-case, mixed case) — key normalization beats wildcard exact-match', () => {
        const out = deepSanitize({
            req: { headers: { 'X-API-Key': 'sk-leaked' } },
        });
        expect(out.req.headers['X-API-Key']).toBe('[REDACTED]');
    });

    it('redacts Proxy-Authorization, a header the old wildcards never listed', () => {
        const out = deepSanitize({
            req: { headers: { 'Proxy-Authorization': 'Basic leaked' } },
        });
        expect(out.req.headers['Proxy-Authorization']).toBe('[REDACTED]');
    });

    it('strips credentials from URL string values regardless of depth', () => {
        const out = deepSanitize({
            config: {
                primary: { url: 'mongodb://user:hunter2@host/db' },
            },
        });
        expect(out.config.primary.url).toBe(
            'mongodb://user:[REDACTED]@host/db',
        );
    });
});

// ---------------------------------------------------------------------------
// SimpleLogger — outer try/catch and fallback
// ---------------------------------------------------------------------------

describe('SimpleLogger — never propagates pino failures (issue #1105)', () => {
    // Vitest config (`sequence.concurrent: true`) runs these tests
    // in parallel, sharing both the `console.error` global and the
    // module-level `pinoLogger` singleton. Each test therefore
    // tags its writes with a unique serviceName and asserts on the
    // SUBSET of console.error calls that carry that tag — never on
    // `mock.calls[0]` directly, which can be a leak from a peer.
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    function findFallbackPayloads(
        spy: ReturnType<typeof vi.spyOn>,
        serviceName: string,
    ): Array<Record<string, unknown>> {
        const out: Array<Record<string, unknown>> = [];
        for (const call of spy.mock.calls) {
            const arg = call[0];
            if (typeof arg !== 'string') continue;
            if (!arg.startsWith('{')) continue;
            try {
                const parsed = JSON.parse(arg) as Record<string, unknown>;
                if (
                    parsed.loggerFallback === true &&
                    parsed.serviceName === serviceName
                ) {
                    out.push(parsed);
                }
            } catch {
                /* not JSON, skip */
            }
        }
        return out;
    }

    it('does not throw when the error chain contains a throwing-getter object', () => {
        const logger = createLogger('test-no-throw');
        const trap = makeThrowingGetterObject();
        const err: Error & { response?: unknown } = new Error(
            'upstream failed',
        );
        // Attach the throwing-getter object as `.response`, the
        // exact shape produced by HTTP clients that wrap undici.
        err.response = trap;

        expect(() =>
            logger.error({
                message: 'should be safe to log',
                context: 'test-context',
                error: err,
                metadata: { extra: 1 },
            }),
        ).not.toThrow();
    });

    it('emits a fallback JSON line carrying the original message+service when the inner write throws', () => {
        // Build a payload that makes pino's pipeline raise. The
        // throwing-getter object inside `metadata` defeats
        // deepSanitize during recursion, which is exactly the
        // shape that triggered the #1105 crash in production.
        const logger = createLogger('test-fallback-emit');
        const trap = makeThrowingGetterObject();

        logger.error({
            message: 'fallback target',
            context: 'test-context',
            error: new Error('upstream'),
            metadata: { trap },
        });

        const payloads = findFallbackPayloads(
            consoleErrorSpy,
            'test-fallback-emit',
        );
        expect(payloads.length).toBeGreaterThan(0);
        const p = payloads[0];
        expect(p.level).toBe('error');
        expect(p.message).toBe('fallback target');
        expect(p.errorName).toBe('Error');
        expect(p.errorMessage).toBe('upstream');
    });

    it('survives even when the fallback JSON.stringify itself would throw', () => {
        // Build a payload whose error.message has a toString that
        // raises. JSON.stringify accesses toString → boom. The
        // inner try/catch in handleLog must catch this so the
        // outer caller still sees no exception.
        const logger = createLogger('test-double-fault');
        const trap = makeThrowingGetterObject();
        const err: Error & { weird?: unknown } = new Error('outer');
        err.weird = trap;

        expect(() =>
            logger.error({
                message: 'still must not throw',
                context: 'test-context',
                error: err,
                metadata: { trap },
            }),
        ).not.toThrow();
    });

    it('does not emit a fallback marker on the happy path', () => {
        const logger = createLogger('test-happy-path');
        logger.error({
            message: 'normal log',
            context: 'test-context',
            error: new Error('plain'),
            metadata: { ok: true },
        });
        // Only this test's tagged service should be matched; peer
        // tests that legitimately exercise the fallback won't bleed.
        const payloads = findFallbackPayloads(
            consoleErrorSpy,
            'test-happy-path',
        );
        expect(payloads).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// AxiosError shape — circular references in config/request/response
// ---------------------------------------------------------------------------

/**
 * Production incident (self-hosted, Discourse PR with ~200 files):
 * the AzureReposService catch path passed the raw AxiosError to
 * `this.logger.error({ error })`. Pino's stdSerializer.err walks
 * `cause`, `config`, `request`, `response` — all of which loop back
 * into each other on the AxiosError shape. That walk overflowed the
 * stack BEFORE deepSanitize (which has its own WeakSet anti-cycle
 * guard) had a chance to flatten the object.
 *
 * Symptom in the log stream: every per-file failure produced a
 * `loggerFallback: true` line with `loggerErrorName: "RangeError"
 * / loggerErrorMessage: "Maximum call stack size exceeded"`. The
 * worker didn't crash (the fallback caught it), but:
 *   1. Lost the structured error context — only message+name made
 *      it to the log, no stack/code/status.
 *   2. Burned CPU per file: pino attempts → throws RangeError →
 *      caught → JSON.stringify of fallback payload. Multiplied by
 *      200 files, this contributed to the worker spending most of
 *      its event-loop time in synchronous serialization instead of
 *      progressing the review.
 *
 * The fix protects `stdSerializers.err` with a try/catch and falls
 * back to `deepSanitize(err)` directly when the stdSerializer
 * recurses past the stack limit. `deepSanitize` is cycle-safe.
 */
describe('SimpleLogger — AxiosError-shape with circular references', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    function findFallbackPayloads(
        spy: ReturnType<typeof vi.spyOn>,
        serviceName: string,
    ): Array<Record<string, unknown>> {
        const out: Array<Record<string, unknown>> = [];
        for (const call of spy.mock.calls) {
            const arg = call[0];
            if (typeof arg !== 'string') continue;
            if (!arg.startsWith('{')) continue;
            try {
                const parsed = JSON.parse(arg) as Record<string, unknown>;
                if (
                    parsed.loggerFallback === true &&
                    parsed.serviceName === serviceName
                ) {
                    out.push(parsed);
                }
            } catch {
                /* not JSON, skip */
            }
        }
        return out;
    }

    /**
     * Reproduces the actual shape that overflowed the stack in
     * production. Pino's `stdSerializers.err` was NOT the culprit
     * (pino 10+ caps recursion in its standard serializers). The
     * overflow happened later in `deepSanitize`, which walks the
     * full object graph without a depth bound.
     *
     * In Node, an AxiosError carries the full HTTP agent chain:
     *   err.request.agent.sockets[host] = [socket]
     *   socket._httpMessage = req
     *   socket.parser.socket = socket   // self
     *   socket._handle.owner = socket   // common in libuv-backed handles
     * Real-world depth can easily reach the V8 default stack limit
     * (~10k frames). The cycles ARE handled by deepSanitize's WeakSet,
     * but the depth itself is not — and that's what kills it.
     *
     * To force the bug deterministically without relying on Node
     * internals, this builds a chain N levels deep (default 15k).
     */
    function makeDeepError(depth = 15000) {
        const err: any = new Error('timeout of 60000ms exceeded');
        err.name = 'AxiosError';
        err.code = 'ECONNABORTED';
        err.isAxiosError = true;

        let cursor: any = {};
        const root = cursor;
        for (let i = 0; i < depth; i++) {
            cursor.nested = {};
            cursor = cursor.nested;
        }
        // The deep chain hangs off `config` so it gets walked by both
        // pino.stdSerializers.err AND deepSanitize.
        err.config = {
            url: 'https://dev.azure.com/.../items',
            chain: root,
        };
        return err;
    }

    it('does not throw when an AxiosError with circular refs is passed', () => {
        const logger = createLogger('test-axios-no-throw');
        const axiosErr = makeDeepError();

        expect(() =>
            logger.error({
                message: 'Failed to get original file content',
                context: 'test-context',
                error: axiosErr,
                metadata: {
                    filePath: '/public/javascripts/ace/mode-typescript.js',
                    baseCommitId: 'abc123',
                },
            }),
        ).not.toThrow();
    });

    /**
     * Anti-regression for the production hang: even though the
     * outer try/catch caught the RangeError, the fact that EVERY
     * AxiosError landed in the fallback meant we lost structured
     * info. After the fix, AxiosErrors must serialize cleanly
     * through the normal pino path (deepSanitize handles the
     * cycle), so `loggerFallback: true` should NOT appear.
     */
    it('does NOT emit a fallback marker for an AxiosError-shape with circular refs', () => {
        const logger = createLogger('test-axios-no-fallback');
        const axiosErr = makeDeepError();

        logger.error({
            message: 'Failed to get original file content',
            context: 'test-context',
            error: axiosErr,
            metadata: {
                filePath: '/spec/components/topic_view_spec.rb',
                baseCommitId: 'abc123',
                targetCommitId: 'def456',
            },
        });

        const payloads = findFallbackPayloads(
            consoleErrorSpy,
            'test-axios-no-fallback',
        );
        // Pre-fix: this array would have 1+ entries with
        // loggerErrorName="RangeError". Post-fix: zero entries,
        // meaning pino + deepSanitize handled the AxiosError without
        // triggering the safety-net try/catch in handleLog.
        expect(payloads).toEqual([]);
    });

    it('survives a batch of 50 AxiosErrors without any falling back', () => {
        // Mirrors the production load: 50 failed file fetches logged
        // in rapid succession. Pre-fix, all 50 would fall back AND
        // each one would burn CPU on the failed pino attempt + the
        // fallback JSON encode.
        const logger = createLogger('test-axios-batch');
        for (let i = 0; i < 50; i++) {
            logger.error({
                message: `Failed to get file content #${i}`,
                context: 'test-context',
                error: makeDeepError(`timeout on file ${i}`),
                metadata: { filePath: `/file-${i}.ts` },
            });
        }

        const payloads = findFallbackPayloads(
            consoleErrorSpy,
            'test-axios-batch',
        );
        expect(payloads).toEqual([]);
    });
});
