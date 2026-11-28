import { errorSignature } from './error-signature';
import { type SpecResult, specResultOf, type TestResult } from './types';

// Mochawesome JSON (Cypress's mochawesome reporter): `results` are spec files,
// each with nested `suites` of `tests`. The runner keeps no per-attempt detail
// here, so a test has one attempt.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObj) : []);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function testOf(t: Json): TestResult {
    const ms = typeof t.duration === 'number' && t.duration > 0 ? Math.round(t.duration) : 0;
    const title = text(t.fullTitle) ?? text(t.title) ?? '';
    const err = isObj(t.err) ? t.err : {};
    const error = text(err.estack) ?? text(err.message);
    if (t.state === 'failed' || t.fail === true) return { title, status: 'failed', attempts: [{ status: 'failed', ms, ...(error ? { error } : {}) }] };
    if (t.pending === true || t.state === 'pending') return { title, status: 'pending', attempts: [{ status: 'skipped', ms }] };
    if (t.skipped === true || t.state === 'skipped') return { title, status: 'skipped', attempts: [{ status: 'skipped', ms }] };
    return { title, status: 'passed', attempts: [{ status: 'passed', ms }] };
}

function collect(node: Json, out: TestResult[]) {
    for (const t of list(node.tests)) out.push(testOf(t));
    for (const s of list(node.suites)) collect(s, out);
}

export function parseMochawesome(jsonText: string): SpecResult[] {
    let doc: unknown;
    try {
        doc = JSON.parse(jsonText);
    } catch {
        throw new Error('not a Mochawesome report: the text is not JSON');
    }
    if (!isObj(doc) || !Array.isArray(doc.results)) throw new Error('not a Mochawesome report: no results array');
    const specs: SpecResult[] = [];
    for (const r of list(doc.results)) {
        const tests: TestResult[] = [];
        collect(r, tests);
        if (tests.length === 0) continue;
        specs.push(specResultOf(text(r.file) ?? text(r.fullFile) ?? '(unknown spec)', tests, errorSignature));
    }
    return specs;
}
