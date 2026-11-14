import { redactPatterns } from '@libs/runtime/redaction/redaction';

import type { BrowserStep, ProbeSpec } from './probe.schema';

// What a probe exercised, for the developer to read: built from the probe's
// typed spec only, never from the agent's words. It names, it never covers:
// coverage stays the observer's request log (S-32, entry-points/coverage.ts).

export const MAX_EXERCISED = 256;

/** Path without query or fragment (they carry tokens more than routes), secrets redacted. */
const routeOf = (path: string) => redactPatterns(path.split(/[?#]/, 1)[0] || '/').text;

const clip = (s: string) => (s.length > MAX_EXERCISED ? `${s.slice(0, MAX_EXERCISED - 1)}…` : s);

/**
 * `GET /api/health` for http, `browser /login` for the first page a browser
 * probe opens, `SQL on db` for sql. A shell probe never decides and has no label.
 */
export function exercisedOf(spec: ProbeSpec): string | undefined {
    switch (spec.kind) {
        case 'http':
            return clip(`${spec.method} ${routeOf(spec.path)}`);
        case 'browser': {
            const first = spec.steps.find((s): s is { goto: string } => 'goto' in s);
            return first ? clip(`browser ${routeOf(first.goto)}`) : undefined;
        }
        case 'sql':
            return clip(`SQL on ${redactPatterns(spec.target.service).text}`);
        default:
            return undefined;
    }
}

export const MAX_STEP_TARGET = 128;

/**
 * What a browser step acts on, from the probe's typed step only: the
 * selector of click, fill, select, waitFor, expectText and getAttribute, the
 * route of a goto, the key of a press, the name of a screenshot. Never the
 * text a step types or expects, never what the page held. Redacted, at most
 * 128 characters.
 */
export function browserStepTargetOf(step: BrowserStep | undefined): string | undefined {
    if (!step) return undefined;
    const [kind, value] = Object.entries(step)[0] ?? [];
    const raw = kind === 'goto' && typeof value === 'string' ? routeOf(value) : Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return undefined;
    const flat = redactPatterns(raw.replace(/[\u0000-\u001f\u007f]+/g, ' ')).text.trim();
    if (!flat) return undefined;
    return flat.length > MAX_STEP_TARGET ? `${flat.slice(0, MAX_STEP_TARGET - 1)}…` : flat;
}
