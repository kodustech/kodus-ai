import {
    evaluateIntentAssertion,
    type IntentAnswer,
    type IntentAssertion,
    intentAssertionReads,
    intentAssertionText,
    isRouteInvariant,
    type StatedIntent,
} from '@libs/runtime/contracts/probe-assertions';
import { requestMatchesEntryPoint, routeShapeOf } from '@libs/runtime/entry-points/coverage';
import type { Probe, ProbeResult } from '@libs/runtime/probe/probe.schema';

import type { FindingKind, GateStep, Verdict } from './gate';
import { LATEST_IMAGE } from './gate';

// The intent oracle's verdict (docs/runtime/intent-oracle.md §7, §8): what the
// PR says it does, as closed assertions the intent author quoted from its
// text, checked on the PR side's rounds. Pure: the assertions were written
// before the Run tested anything, and only fields the observer produced
// decide. A failed assertion is an intent mismatch (advisory); a passed one
// may explain a difference from main, never a 5xx, never a field it does not
// read.

/** The assertions of one intent probe and the sentence they quote. */
export interface StatedIntentCheck {
    probeId: string;
    intent: StatedIntent;
    assertions: IntentAssertion[];
}

/** What one intent probe's assertions did on the PR side's rounds. */
export interface StatedIntentResult {
    probeId: string;
    quote: string;
    source: StatedIntent['source'];
    /** Assertions checked, those that held on every PR round, and those no round could evaluate (never a failure, never held). */
    assertions: number;
    held: number;
    inconclusive: number;
    /** PR rounds the assertions were checked on. */
    rounds: number;
    /** Each assertion that failed, on the first PR round it failed. */
    failures: Array<{ assertion: string; expected: string; received: string }>;
}

type VerdictLike = { verdict: Verdict; reason: string; findingKind?: FindingKind; differingFields?: string[]; intendedChange?: unknown };

/** A value of the answer, as the comment can carry it. */
const VALUE_CHARS = 200;
const cut = (s: string) => (s.length > VALUE_CHARS ? `${s.slice(0, VALUE_CHARS - 1)}…` : s);

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function parsed(text: string | undefined): { ok: true; value: unknown } | { ok: false } {
    if (text === undefined) return { ok: false };
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch {
        return { ok: false };
    }
}

const requestOf = (body: string | undefined) => {
    const r = parsed(body);
    return r.ok ? { request: r.value } : {};
};

/** The PR's answer from the observer's raw result: what an intent probe's own rounds expect (GateStep.expectedHolds). */
export function intentAnswerOfResult(result: Pick<ProbeResult, 'http'>, requestBody?: string): IntentAnswer | undefined {
    if (!result.http) return undefined;
    const body = parsed(result.http.body);
    return { status: result.http.status, body: body.ok ? { json: true, value: body.value } : { json: false, text: result.http.body }, ...requestOf(requestBody) };
}

/**
 * The same answer read back from a round's compared fields (probe-fields.ts
 * `flatten`): `json` holds a root that is not an object (an array, a scalar,
 * `{}`) or `not_json`; otherwise each `json.a.b` is one value, its JSON.
 */
export function intentAnswerOfFields(fields: Record<string, string>, requestBody?: string): IntentAnswer {
    const status = /^\d{3}$/.test(fields.status ?? '') ? Number(fields.status) : undefined;
    const withStatus = status !== undefined ? { status } : {};
    if ('json' in fields) {
        const root = fields.json === 'not_json' ? ({ ok: false } as const) : parsed(fields.json);
        // A body that is not JSON keeps only an HTML page's visible text among its fields.
        const text = fields['html.text'] !== undefined ? { text: fields['html.text'] } : {};
        return { ...withStatus, body: root.ok ? { json: true, value: root.value } : { json: false, ...text }, ...requestOf(requestBody) };
    }
    const keys = Object.keys(fields).filter((k) => k.startsWith('json.'));
    if (!keys.length) return { ...withStatus, body: { json: false }, ...requestOf(requestBody) };
    // Null-prototype objects: a key the app answers (`__proto__`) is only a key.
    const root: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
        const parts = key.slice('json.'.length).split('.');
        let at = root;
        for (const part of parts.slice(0, -1)) {
            if (!isPlainObject(at[part])) at[part] = Object.create(null);
            at = at[part] as Record<string, unknown>;
        }
        const leaf = parsed(fields[key]);
        at[parts[parts.length - 1]] = leaf.ok ? leaf.value : fields[key];
    }
    return { ...withStatus, body: { json: true, value: root }, ...requestOf(requestBody) };
}

/** Whether every assertion of every check holds on one raw answer; undefined without an HTTP answer. */
export function statedIntentHolds(result: Pick<ProbeResult, 'http'>, checks: readonly StatedIntentCheck[], requestBody?: string): boolean | undefined {
    const answer = intentAnswerOfResult(result, requestBody);
    if (!answer) return undefined;
    const outcomes = checks.flatMap((c) => c.assertions.map((a) => outcomeOf(c, a, answer).outcome));
    if (outcomes.includes('failed')) return false;
    return outcomes.includes('inconclusive') ? undefined : true;
}

const isClientError = (status: number | undefined) => status !== undefined && status >= 400 && status < 500;

/**
 * One assertion on one answer, as the oracle reads it. An expression that
 * cannot be computed is inconclusive. On an answer the app refused (4xx), an
 * assertion other than the status is inconclusive unless the probe asserts a
 * 4xx itself (the refusal is what the text describes, kr-shop #13): a field of
 * a refusal says nothing about a request the text did not mean to refuse
 * (kr-shop #8), and a 2xx the probe asserts is what fails.
 */
function outcomeOf(check: StatedIntentCheck, a: IntentAssertion, answer: IntentAnswer): { outcome: 'held' | 'failed' | 'inconclusive'; expected: string; received: string } {
    const r = evaluateIntentAssertion(a, answer);
    const refusalAsserted = check.assertions.some((x) => x.kind === 'status' && isClientError(x.status));
    if (a.kind !== 'status' && isClientError(answer.status) && !refusalAsserted) return { outcome: 'inconclusive', expected: r.expected, received: r.received };
    return { outcome: r.inconclusive ? 'inconclusive' : r.held ? 'held' : 'failed', expected: r.expected, received: r.received };
}

const healthy = (s: GateStep) => s.transport === 'ok' && s.vmHealth === 'ok' && !s.timedOut;

/** The PR rounds the assertions are checked on: every observer round of the PR, healthy and on one pinned image; else none. */
function prRounds(steps: GateStep[], pinnedImageId: string): GateStep[] {
    const pr = steps.filter((s) => s.executor === 'observer' && s.side === 'pr').sort((a, b) => a.round - b.round);
    if (!pr.length || !pr.every(healthy)) return [];
    const images = new Set(pr.map((s) => s.imageId));
    const pinned = pinnedImageId === LATEST_IMAGE ? images.size === 1 : images.size === 1 && images.has(pinnedImageId);
    return pinned ? pr : [];
}

function evaluate(check: StatedIntentCheck, answers: IntentAnswer[]): StatedIntentResult {
    const failures: StatedIntentResult['failures'] = [];
    let held = 0;
    let inconclusive = 0;
    for (const a of check.assertions) {
        const outcomes = answers.map((answer) => outcomeOf(check, a, answer));
        const failed = outcomes.find((o) => o.outcome === 'failed');
        if (failed) failures.push({ assertion: cut(intentAssertionText(a)), expected: cut(failed.expected), received: cut(failed.received) });
        else if (outcomes.some((o) => o.outcome === 'inconclusive')) inconclusive++;
        else held++;
    }
    return { probeId: check.probeId, quote: check.intent.quote, source: check.intent.source, assertions: check.assertions.length, held, inconclusive, rounds: answers.length, failures };
}

const isBodyField = (f: string) => f === 'json' || f.startsWith('json.') || f.startsWith('html.') || f.startsWith('body.');

/**
 * Whether passed assertions read every field that differs. A status that
 * changed as asserted carries its body with it: the PR answers another
 * outcome, whose body says nothing next to main's (kr-shop #14, 201 → 400).
 * A path through an array index reads one element, never the whole array.
 */
function readsEveryDifference(differing: string[], checks: readonly StatedIntentCheck[]): boolean {
    const reads = checks.flatMap((c) => c.assertions.map(intentAssertionReads));
    const status = reads.some((r) => r.status);
    const statusChanged = differing.includes('status');
    const fields = [
        ...reads
            .flatMap((r) => r.paths)
            .filter((p) => p.every((s) => typeof s === 'string'))
            .map((p) => ['json', ...p].join('.')),
        ...explainedArrays(checks),
    ];
    const read = (f: string) =>
        f === 'status' ? status : isBodyField(f) && ((status && statusChanged) || fields.some((p) => f === p || f.startsWith(`${p}.`)));
    return differing.length > 0 && differing.every(read);
}

const keysOnly = (p: readonly unknown[]): p is string[] => p.every((s) => typeof s === 'string');
const ONLY = /\bonly\b/i;

/**
 * The arrays whose whole value passed assertions explain: an `every` states
 * what each element is, and the size is stated too, by a length assertion on
 * the same array or by a sentence that says "only" (a filter, kr-shop #10).
 * An `every` alone without "only" explains no array; neither does a length.
 */
function explainedArrays(checks: readonly StatedIntentCheck[]): string[] {
    const lengths = new Set(
        checks
            .flatMap((c) => c.assertions.filter((a) => a.kind === 'equals').map((a) => intentAssertionReads(a).paths[0]))
            .filter((p) => p.length > 0 && p[p.length - 1] === 'length')
            .map((p) => JSON.stringify(p.slice(0, -1))),
    );
    const out: string[] = [];
    for (const c of checks) {
        for (const a of c.assertions) {
            for (const array of intentAssertionReads(a).arrays ?? []) {
                if (keysOnly(array) && (lengths.has(JSON.stringify(array)) || ONLY.test(c.intent.quote))) out.push(['json', ...array].join('.'));
            }
        }
    }
    return out;
}

/** Verdicts an intent mismatch may stand in for: a comparison that found no failure of its own. */
const MISMATCH_OVER: ReadonlySet<Verdict> = new Set<Verdict>(['not_reproduced', 'pre_existing', 'new_endpoint', 'inconclusive']);

/**
 * The verdict once the PR's stated intent is checked on the PR side's rounds:
 * - an assertion fails on a round and `mismatch` (an intent probe): `intent_mismatch`,
 *   in place of a comparison that found nothing failing (never over a 5xx, a lost
 *   machine or an error on a new endpoint, which stay findings);
 * - every assertion held on every round, the decision is a `behavior_change`, the
 *   PR answered no 5xx and the assertions read every differing field:
 *   `described_change`;
 * - otherwise the decision as it was. `mismatch` false (a planned probe of the same
 *   request) only ever explains: its own regression stands when an assertion fails.
 */
export function decideStatedIntent<D extends VerdictLike>(
    decision: D,
    steps: GateStep[],
    checks: readonly StatedIntentCheck[],
    opts: { mismatch: boolean; pinnedImageId: string; requestBody?: string },
): { decision: D; statedIntents: StatedIntentResult[] } {
    const rounds = prRounds(steps, opts.pinnedImageId);
    if (!rounds.length || !checks.length) return { decision, statedIntents: [] };
    const answers = rounds.map((s) => intentAnswerOfFields(s.fields, opts.requestBody));
    const statedIntents = checks.map((c) => evaluate(c, answers));
    const pr5xx = rounds.some((s) => Number(s.fields.status) >= 500);
    const { findingKind: _kind, intendedChange: _intended, ...rest } = decision;
    if (statedIntents.some((r) => r.failures.length)) {
        const overridable = MISMATCH_OVER.has(decision.verdict) || (decision.verdict === 'finding' && decision.findingKind === 'behavior_change' && !pr5xx);
        if (!opts.mismatch || !overridable) return { decision, statedIntents };
        return { decision: { ...rest, verdict: 'intent_mismatch', reason: "an assertion quoted from the pull request's own text fails on this PR" } as D, statedIntents };
    }
    const differing = decision.differingFields ?? [];
    // An assertion no round could evaluate explains nothing.
    const allHeld = statedIntents.every((r) => r.inconclusive === 0);
    if (decision.verdict === 'finding' && decision.findingKind === 'behavior_change' && !pr5xx && allHeld && readsEveryDifference(differing, checks)) {
        return { decision: { ...rest, verdict: 'described_change', reason: "every difference from main is what the pull request's own text says, and it held on every PR round" } as D, statedIntents };
    }
    return { decision, statedIntents };
}

const sortedKeys = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sortedKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys((v as any)[k])])) : v;

const canonicalBody = (body: string | undefined) => {
    if (body === undefined || body === '') return '';
    const r = parsed(body);
    return r.ok ? JSON.stringify(sortedKeys(r.value)) : body;
};

/** One request: method, path with its query, target and JSON body (key order aside). Headers aside: the assertions read the planned probe's own answers. */
export function sameHttpRequest(a: Probe, b: Probe): boolean {
    if (a.spec.kind !== 'http' || b.spec.kind !== 'http') return false;
    return (
        a.spec.method === b.spec.method &&
        a.spec.path === b.spec.path &&
        a.spec.target.service === b.spec.target.service &&
        a.spec.target.port === b.spec.target.port &&
        canonicalBody(a.spec.body) === canonicalBody(b.spec.body)
    );
}

/** An intent probe as the checks read it (contracts/run-plan.ts IntentProbe). */
type IntentProbeLike = { probe: Probe; intent: StatedIntent; intentAssertions: IntentAssertion[] };

const checkOf = (p: IntentProbeLike, assertions = p.intentAssertions): StatedIntentCheck => ({ probeId: p.probe.id, intent: p.intent, assertions });

const queryKeys = (path: string) => [...new Set(new URLSearchParams(path.split('?')[1] ?? '').keys())].sort().join('&');
const bodyKeys = (body: string | undefined) => {
    const r = parsed(body);
    if (body === undefined || body === '') return '';
    return r.ok && isPlainObject(r.value) ? JSON.stringify(Object.keys(r.value).sort()) : undefined;
};

/** Same method and route, the same query keys and the same JSON body keys; values aside (kr-shop #18). */
function sameRequestShape(a: Probe, b: Probe): boolean {
    if (a.spec.kind !== 'http' || b.spec.kind !== 'http' || a.spec.method !== b.spec.method) return false;
    const keys = bodyKeys(a.spec.body);
    return keys !== undefined && keys === bodyKeys(b.spec.body) && queryKeys(a.spec.path) === queryKeys(b.spec.path);
}

/**
 * The intent checks a planned probe gets. An intent probe of the same request
 * gives every assertion it has, and a failure is recorded beside the planned
 * verdict (which keeps its regression). Without one, the intent probes of the
 * same method and route (the planned probe's covered entry point,
 * `GET /orders/:id`) give their rules over response fields (`isRouteInvariant`),
 * and those of the same request shape (`sameRequestShape`) their status too:
 * a sentence quoted for one request may explain another's difference, never
 * flag it (`explainOnly`). A literal `equals` stays with its own request.
 */
export function statedIntentChecksFor(planned: { probe: Probe; entryPoint: string }, intents: readonly IntentProbeLike[]): { checks: StatedIntentCheck[]; explainOnly: boolean } {
    const twins = intents.filter((ip) => sameHttpRequest(planned.probe, ip.probe));
    if (twins.length) return { checks: twins.map((ip) => checkOf(ip)), explainOnly: false };
    if (planned.probe.spec.kind !== 'http' || planned.entryPoint === 'unmapped') return { checks: [], explainOnly: true };
    const route = planned.entryPoint;
    const checks = intents
        .filter((ip) => ip.probe.spec.kind === 'http' && ip.probe.spec.method === (planned.probe.spec as { method: string }).method)
        .filter((ip) => requestMatchesEntryPoint(route, { method: (ip.probe.spec as { method: string }).method, route: routeShapeOf((ip.probe.spec as { path: string }).path) }))
        .map((ip) => checkOf(ip, ip.intentAssertions.filter((a) => isRouteInvariant(a) || (a.kind === 'status' && sameRequestShape(planned.probe, ip.probe)))))
        .filter((c) => c.assertions.length > 0);
    return { checks, explainOnly: true };
}
