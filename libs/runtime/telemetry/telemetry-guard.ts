import type { Attributes, AttributeValue } from '@opentelemetry/api';

import { redactPatterns } from '@libs/runtime/redaction/redaction';

import { ATTR, canonicalKey, dimension, idValue, TAXONOMY, type AttrKey } from './catalog';

// The redaction rule of Runtime telemetry (docs/runtime/observability.md,
// "Never in telemetry"): no secret value, placeholder, canary, token, repo
// content, command output or env value reaches a log line, a span or a
// metric. Three gates, one per signal:
//   - metric labels: only the labels the catalog lists, dimension values
//     closed, ids shaped like ids (metricAttributes);
//   - span attributes: only taxonomy keys (plus the few OTel ones the SDK
//     sets), each value checked the same way (spanAttributes), applied to
//     every span by RedactingSpanExporter before it leaves the process;
//   - log fields: free keys, but every string scrubbed (scrubText) and
//     sensitive keys dropped (diagnostic-fields.ts).

const MAX_TEXT = 512;

/**
 * Values that are secret by shape, beyond the shared token rules: the
 * cell's placeholder (kph_ + 32 base32), the Run's canaries (npm_, kdx_live_,
 * seed_ + 32 hex, libs/runtime/canary), a Team CLI key (kodus_...), a bearer
 * credential and a JWT. The Go cell scrubs the same shapes
 * (internal/telemetry, from the generated protocol constants).
 */
export const TELEMETRY_SECRET_SHAPES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
    { id: 'placeholder', pattern: /kph_[a-z2-7]{32}/gi },
    { id: 'canary', pattern: /\b(?:npm|kdx_live|seed)_[0-9a-f]{32}\b/gi },
    { id: 'team-key', pattern: /\bkodus_[A-Za-z0-9_-]{16,}/g },
    { id: 'bearer', pattern: /\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
    { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
    { id: 'url-credential', pattern: /\/\/[^/\s:@]+:[^/\s@]+@/g },
];

export interface Scrubbed {
    text: string;
    redacted: boolean;
}

/** The text with every secret-shaped part replaced by [redacted:<rule>], bounded. */
export function scrubText(value: string): Scrubbed {
    let text = value.length > 4 * MAX_TEXT ? value.slice(0, 4 * MAX_TEXT) : value;
    let redacted = false;
    for (const s of TELEMETRY_SECRET_SHAPES) {
        s.pattern.lastIndex = 0;
        if (s.pattern.test(text)) {
            s.pattern.lastIndex = 0;
            text = text.replace(s.pattern, `[redacted:${s.id}]`);
            redacted = true;
        }
    }
    const tokens = redactPatterns(text);
    if (tokens.count) {
        text = tokens.text;
        redacted = true;
    }
    return { text: text.slice(0, MAX_TEXT), redacted };
}

/** Keys the OTel SDK or our failure helper sets on spans, kept as they are. */
const OTEL_SPAN_KEYS = new Set(['exception.type']);

const attributeSpec = (key: string) => TAXONOMY.attributes[key];

/** One attribute value as telemetry may carry it, or undefined (dropped). */
function attributeValue(key: string, value: unknown): AttributeValue | undefined {
    const spec = attributeSpec(key);
    if (!spec) {
        if (!OTEL_SPAN_KEYS.has(key)) return undefined;
        if (typeof value === 'number' || typeof value === 'boolean') return value;
        return typeof value === 'string' && !scrubText(value).redacted ? value.slice(0, 128) : undefined;
    }
    if (spec.cardinality === 'dimension') return dimension(key as AttrKey, value);
    if (spec.type === 'int') return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
    // An id, a host, a model: a short value of an id's shape and nothing secret-shaped.
    if (key === ATTR.serverAddress || key === ATTR.model) {
        return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,252}$/.test(value) && !scrubText(value).redacted ? value : undefined;
    }
    const id = idValue(value);
    return id !== undefined && !scrubText(id).redacted ? id : undefined;
}

/** Span attributes as they may leave the process: canonical taxonomy keys, checked values; the rest dropped. */
export function spanAttributes(attrs: Attributes | undefined): Attributes {
    const out: Attributes = {};
    if (!attrs) return out;
    for (const [raw, value] of Object.entries(attrs)) {
        const key = canonicalKey(raw);
        const v = attributeValue(key, value);
        if (v !== undefined) out[key] = v;
    }
    return out;
}

const LOCAL_LABEL = /^[a-z][a-z0-9_.]{0,63}$/;

/**
 * The labels of one metric point: only those the catalog lists for `metric`,
 * a dimension closed to its values, the organization shaped like an id. A
 * metric-local label (outcome, reason, code, op, kind, where) is a short
 * snake-case word chosen by code; anything else is "other".
 */
export function metricAttributes(metric: string, attrs: Record<string, unknown>): Attributes {
    const spec = TAXONOMY.metrics[metric];
    if (!spec) throw new Error(`metric ${metric} is not in the taxonomy`);
    const out: Attributes = {};
    for (const label of spec.labels) {
        const value = attrs[label];
        if (label in TAXONOMY.metricLocalLabels) {
            out[label] = typeof value === 'string' && LOCAL_LABEL.test(value) && !scrubText(value).redacted ? value : 'other';
            continue;
        }
        const a = attributeSpec(label);
        if (!a) throw new Error(`label ${label} of ${metric} is not in the taxonomy`);
        if (a.cardinality === 'dimension') out[label] = dimension(label as AttrKey, value);
        else if (a.cardinality === 'tenant') out[label] = attributeValue(label, value) ?? 'unknown';
        else throw new Error(`label ${label} of ${metric} is an id: ids never become metric labels`);
    }
    return out;
}
