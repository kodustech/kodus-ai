// jsdom (used by React component specs) doesn't polyfill TextEncoder/
// TextDecoder — needed transitively by `jose` (imported from apps/web's
// helpers.ts). Node's node environment already has these globally, so this
// is a no-op there.
if (typeof (globalThis as any).TextEncoder === 'undefined') {
    const { TextEncoder, TextDecoder } = require('util');
    (globalThis as any).TextEncoder = TextEncoder;
    (globalThis as any).TextDecoder = TextDecoder;
}

if (!process.env.API_CRYPTO_KEY) {
    process.env.API_CRYPTO_KEY =
        '0000000000000000000000000000000000000000000000000000000000000000';
}

if (!process.env.CODE_MANAGEMENT_SECRET) {
    process.env.CODE_MANAGEMENT_SECRET =
        '0000000000000000000000000000000000000000000000000000000000000000';
}

if (!process.env.CODE_MANAGEMENT_WEBHOOK_TOKEN) {
    process.env.CODE_MANAGEMENT_WEBHOOK_TOKEN = 'test-webhook-token';
}

if (!process.env.API_LOG_LEVEL) {
    process.env.API_LOG_LEVEL = 'error';
}

// Mock logger globally to silence logs during tests. createLogger lives in
// libs/core/log now — silence it there so specs stay quiet (and don't spin up
// pino's worker-thread transport under jest).
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

// The observability/tracing subsystem was ported out of into
// libs/core/observability. The real module connects to MongoDB and arms flush
// timers (open handles) on init — previously it was unreachable under tests
// because the global mock above left getObservability undefined.
// Stub it with a no-op observability so specs don't open real connections or
// leak timers (which made the suite hang for minutes).
jest.mock('@libs/core/observability', () => {
    const span: any = {};
    for (const m of [
        'setAttribute',
        'setAttributes',
        'setStatus',
        'recordException',
        'addEvent',
    ]) {
        span[m] = () => span;
    }
    span.end = () => {};
    span.isRecording = () => false;
    span.getSpanContext = () => ({ traceId: '', spanId: '' });

    const obs = {
        initialize: async () => {},
        setContext: () => {},
        getContext: () => ({ correlationId: 'test-correlation-id' }),
        startSpan: () => span,
        withSpan: (_s: any, fn: () => any) => fn(),
    };

    const id = (v: string) => () => v;
    return {
        getObservability: () => obs,
        IdGenerator: {
            correlationId: id('test-correlation-id'),
            callId: id('test-call-id'),
            executionId: id('test-execution-id'),
            sessionId: id('test-session-id'),
            generate: id('test-id'),
        },
        StorageEnum: { INMEMORY: 'memory', MONGODB: 'mongodb' },
    };
});
