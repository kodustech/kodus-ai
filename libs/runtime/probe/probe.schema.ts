import { z } from 'zod';

import { EVIDENCE_UPLOAD_TYPES } from '@libs/runtime/contracts/evidence';

// Typed probes (ADR-053, docs §5). http, sql and browser run on the claim's
// observer, outside the VM, and are the only kinds that decide a verdict.
// shell runs inside the VM and is internal evidence: it can only accompany a
// finding the observer proved.

const timeoutMs = z.number().int().min(1).max(600_000);

/**
 * A path on the target service: starts with one `/`, never `//` (a
 * protocol-relative URL would leave the target) and never a backslash. The
 * Go observer refuses the same (observer.go), so both sides read one rule.
 */
const servicePath = z
    .string()
    .max(2_048)
    .regex(/^\/([^/\\][^\\]*)?$/);

/** An HTTP header name (RFC 9110 token) and a value without CR or LF. */
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/);
const headerValue = z.string().max(8_192).regex(/^[^\r\n]*$/);

export const ProbeTargetSchema = z.strictObject({
    service: z.string().min(1).max(128),
    port: z.number().int().min(1).max(65_535),
});

export const HttpProbeSchema = z.strictObject({
    kind: z.literal('http'),
    target: ProbeTargetSchema,
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
    path: servicePath,
    headers: z.record(headerName, headerValue).optional(),
    body: z.string().max(65_536).optional(),
    // loginAs(role): the credential is resolved outside the VM, by handle.
    role: z.string().min(1).max(64).optional(),
    timeoutMs,
});

// A first filter only: a writable CTE or EXPLAIN ANALYZE still passes it.
// The guard is the observer's READ ONLY transaction (observer.go); zod
// refinements do not reach the JSON Schema, so the Go side keeps its own copy
// (protocol.CheckReadOnlySQL) and the shared fixtures hold both to it.
const READ_ONLY_SQL = /^\s*(select|with|explain|show)\b/i;

export const SqlProbeSchema = z
    .strictObject({
        kind: z.literal('sql'),
        target: ProbeTargetSchema,
        query: z.string().min(1).max(16_384),
        timeoutMs,
    })
    .refine((p) => READ_ONLY_SQL.test(p.query), {
        message: 'sql probes are read-only: SELECT, WITH, EXPLAIN or SHOW',
        path: ['query'],
    })
    .refine((p) => !/;\s*\S/.test(p.query), {
        message: 'sql probes run a single statement',
        path: ['query'],
    });

const selector = z.string().min(1).max(1_024);

/** The kinds of a browser step, in BrowserStepSchema's order: each step object has exactly one of these keys. */
export const BROWSER_STEP_KINDS = ['goto', 'click', 'fill', 'select', 'press', 'waitFor', 'expectText', 'getAttribute', 'screenshot'] as const;
export type BrowserStepKind = (typeof BROWSER_STEP_KINDS)[number];

// A closed list of steps: no evaluate, no arbitrary script (S-31).
export const BrowserStepSchema = z.union([
    z.strictObject({ goto: servicePath }),
    z.strictObject({ click: selector }),
    z.strictObject({ fill: z.tuple([selector, z.string().max(8_192)]) }),
    z.strictObject({ select: z.tuple([selector, z.string().max(1_024)]) }),
    z.strictObject({ press: z.string().min(1).max(64) }),
    z.strictObject({ waitFor: selector }),
    z.strictObject({ expectText: z.tuple([selector, z.string().max(8_192)]) }),
    z.strictObject({ getAttribute: z.tuple([selector, z.string().min(1).max(128)]) }),
    z.strictObject({ screenshot: z.string().min(1).max(128) }),
]);

export const BrowserProbeSchema = z.strictObject({
    kind: z.literal('browser'),
    steps: z.array(BrowserStepSchema).min(1).max(100),
    viewport: z.strictObject({
        width: z.number().int().min(200).max(4_096),
        height: z.number().int().min(200).max(4_096),
    }),
    role: z.string().min(1).max(64).optional(),
    clock: z.iso.datetime().optional(),
    timeoutMs,
});

export const InternalProbeSchema = z.strictObject({
    kind: z.literal('shell'),
    command: z.string().min(1).max(16_384),
    timeoutMs,
});

export const ProbeSpecSchema = z.union([
    HttpProbeSchema,
    SqlProbeSchema,
    BrowserProbeSchema,
    InternalProbeSchema,
]);

export const CompareFieldSchema = z.enum([
    'exit',
    'status',
    'json',
    'lines',
    'db_count',
    'dom',
    'network',
    'console',
    'pixels',
]);

export const ProbeSchema = z.strictObject({
    id: z.string().min(1).max(128),
    spec: ProbeSpecSchema,
    origin: z.enum(['agent', 'external']),
    evidence: z.enum(['lean', 'full']).optional(),
    purpose: z.string().min(1).max(512),
    expected: z.string().min(1).max(2_048),
    waitFor: z
        .strictObject({ until: z.string().min(1).max(2_048), timeoutMs })
        .optional(),
    sendWebhook: z
        .strictObject({
            fake: z.string().min(1).max(64),
            event: z.string().min(1).max(128),
            payload: z.unknown(),
        })
        .optional(),
    compare: z.array(CompareFieldSchema).min(1).max(9),
});

/** Milliseconds since the round's t0 (when the cell started the probe): one clock for both sides' lanes. */
const sinceT0 = z.number().int().min(0).max(3_600_000);
const count = z.number().int().min(0).max(1_000_000_000);

/** Why a browser step did not pass; `skipped`: an earlier step failed and the runner stopped there. */
export const BROWSER_STEP_ERRORS = ['timeout', 'not_found', 'mismatch', 'navigation', 'refused', 'skipped', 'error'] as const;
export type BrowserStepError = (typeof BROWSER_STEP_ERRORS)[number];

/**
 * One step of a browser probe as the runner played it (ADR-071), on the
 * round's clock. `value` is what an expectText selector held or what a
 * getAttribute read, as text the cell redacted and cut; `screenshot` is the
 * N of the screenshot-N artifact this step took (a screenshot step, or the
 * failing step's).
 */
export const BrowserStepOutcomeSchema = z.strictObject({
    index: z.number().int().min(0).max(99),
    kind: z.enum(BROWSER_STEP_KINDS),
    ok: z.boolean(),
    startMs: sinceT0,
    endMs: sinceT0,
    value: z.string().max(512).optional(),
    error: z.enum(BROWSER_STEP_ERRORS).optional(),
    screenshot: z.number().int().min(0).max(9).optional(),
});
export type BrowserStepOutcome = z.infer<typeof BrowserStepOutcomeSchema>;

/**
 * The cell's pixel diff of one screenshot against the same screenshot of
 * the side's baseline round (main's first): the share of pixels that
 * changed beyond the per-channel tolerance, and whether the two sizes
 * differ (then every pixel counts as changed). Its diff image is pixeldiff-N.
 */
export const PixelDiffSchema = z.strictObject({
    screenshot: z.number().int().min(0).max(9),
    ratio: z.number().min(0).max(1),
    changed: count,
    total: count,
    sizeDiffers: z.boolean(),
});
export type PixelDiff = z.infer<typeof PixelDiffSchema>;

/**
 * One artifact the cell uploaded with its grant (EVIDENCE-CAPTURE-DESIGN):
 * the worker knows its key from the grant it signed; the cell says what it
 * put there, after redaction and the size cap.
 */
export const EvidenceRefSchema = z.strictObject({
    type: z.enum(EVIDENCE_UPLOAD_TYPES),
    bytes: z.number().int().min(0).max(20 * 1_024 * 1_024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    truncated: z.boolean(),
    redactions: count,
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/**
 * What the app did while the probe ran, on the round's clock [t0, t1], as
 * the cell measured it. Each block is present only when the cell captured it
 * (its hello feature, accepted by the hub): an absent block is "not captured
 * on this cell", never "nothing happened". Never compared by the gate.
 */
export const ProbeEvidenceSchema = z.strictObject({
    t0: z.iso.datetime(),
    windowMs: sinceT0,
    // Back-end artifacts and, for a browser probe, up to 10 screenshots, 10 pixel diffs, the video, the trace and the HAR.
    refs: z.array(EvidenceRefSchema).max(32).optional(),
    // serviceLogs: the claim's services' log lines in the window, redacted; the tail here, all of it (256 KB) in the logs artifact.
    logs: z
        .strictObject({
            lines: count,
            truncated: z.boolean(),
            tail: z.array(z.strictObject({ at: sinceT0, service: z.string().min(1).max(128), text: z.string().max(512) })).max(50),
        })
        .optional(),
    // dbEffects: per-table rows inserted, updated and deleted in the window (read-only connection).
    db: z
        .strictObject({
            engine: z.enum(['postgres', 'mysql']),
            service: z.string().min(1).max(128),
            tables: z
                .array(
                    z.strictObject({
                        table: z.string().min(1).max(256),
                        inserted: count,
                        updated: count,
                        deleted: count,
                        // Rows written in the window that the cell read (Postgres, by xmin).
                        rows: count,
                    }),
                )
                .max(20),
            truncated: z.boolean(),
            // Observer to cell agent only: the rows themselves, which the agent redacts,
            // uploads as the db artifact and removes before the result leaves the cell.
            sample: z
                .array(z.strictObject({ table: z.string().min(1).max(256), columns: z.array(z.string().max(256)).max(64), rows: z.array(z.array(z.unknown()).max(64)).max(50) }))
                .max(20)
                .optional(),
        })
        .optional(),
    // outboundCalls: the claim's egress in the window, let through or refused.
    outbound: z
        .strictObject({
            calls: z.array(z.strictObject({ at: sinceT0, host: z.string().min(1).max(253), port: z.number().int().min(1).max(65_535), allowed: z.boolean() })).max(200),
            truncated: z.boolean(),
        })
        .optional(),
});
export type ProbeEvidence = z.infer<typeof ProbeEvidenceSchema>;

export const ProbeResultSchema = z.strictObject({
    stepId: z.uuid(),
    executor: z.literal('observer'),
    imageId: z.string().min(1).max(256),
    http: z
        .strictObject({
            status: z.number().int(),
            headers: z.record(z.string(), z.string()),
            body: z.string().max(1_048_576),
            bodyRef: z.string().max(1_024).optional(),
        })
        .optional(),
    sql: z
        .strictObject({
            columns: z.array(z.string().max(256)).max(256),
            rows: z.array(z.array(z.unknown()).max(256)).max(10_000),
        })
        .optional(),
    browser: z
        .strictObject({
            dom: z.string().optional(),
            network: z
                .array(
                    z.strictObject({
                        method: z.string().max(16),
                        url: z.string().max(8_192),
                        status: z.number().int(),
                        // browser: when the request started on the round's clock, and how long it took (from the HAR).
                        at: sinceT0.optional(),
                        ms: sinceT0.optional(),
                    }),
                )
                .max(2_000),
            console: z.array(z.strictObject({ level: z.string().max(16), text: z.string().max(8_192), at: sinceT0.optional() })).max(2_000),
            screenshotRef: z.string().optional(),
            videoRef: z.string().optional(),
            traceRef: z.string().optional(),
            harRef: z.string().optional(),
            // browser (ADR-071): each step as the runner played it, the pixel diffs
            // against the baseline round, and when the video starts on the round's clock.
            steps: z.array(BrowserStepOutcomeSchema).max(100).optional(),
            pixels: z.array(PixelDiffSchema).max(10).optional(),
            videoStartMs: sinceT0.optional(),
        })
        .optional(),
    // The observer's request log, by method and route: the gate builds
    // entry-point coverage from it, never from an agent label.
    requests: z
        .array(
            z.strictObject({
                method: z.string().max(16),
                route: z.string().max(2_048),
                status: z.number().int(),
                // timedRequests: when the request was sent, on the round's clock.
                at: sinceT0.optional(),
            }),
        )
        .max(2_000),
    durationMs: z.number().int().min(0),
    transport: z.enum(['ok', 'lost']),
    evidence: ProbeEvidenceSchema.optional(),
});

export type ProbeTarget = z.infer<typeof ProbeTargetSchema>;
export type HttpProbe = z.infer<typeof HttpProbeSchema>;
export type SqlProbe = z.infer<typeof SqlProbeSchema>;
export type BrowserStep = z.infer<typeof BrowserStepSchema>;
export type BrowserProbe = z.infer<typeof BrowserProbeSchema>;
export type InternalProbe = z.infer<typeof InternalProbeSchema>;
export type ProbeSpec = z.infer<typeof ProbeSpecSchema>;
export type CompareField = z.infer<typeof CompareFieldSchema>;
export type Probe = z.infer<typeof ProbeSchema>;
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

/** Only probes run by the observer can create or clear a finding. */
export function decidesVerdict(spec: ProbeSpec): boolean {
    return spec.kind !== 'shell';
}
