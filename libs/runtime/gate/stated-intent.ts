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
import { isPathUnder, type LeafChange, type LeafDescribedBy, type LeafChangeSet, leafChanges, LEAF_MENTIONS_MAX, leafPathOf } from '@libs/runtime/run/leaf-changes';

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
    /** Written for another request of the route (`statedIntentChecksFor`): it may explain this one, never flag it. */
    lent?: boolean;
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

type VerdictLike = { verdict: Verdict; reason: string; findingKind?: FindingKind; differingFields?: string[]; maskedFields?: string[]; intendedChange?: unknown };

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
 * Whether a field that differs is read by a passed assertion. A status that
 * changed as asserted carries its body with it: the PR answers another
 * outcome, whose body says nothing next to main's (kr-shop #14, 201 → 400).
 * A path through an array index reads one element, never the whole array: it
 * reads no field here, and `describedLeaf` reads it for the leaf it names.
 */
function fieldReader(differing: string[], checks: readonly StatedIntentCheck[]): (field: string) => boolean {
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
    return (f) => (f === 'status' ? status : isBodyField(f) && ((status && statusChanged) || fields.some((p) => f === p || f.startsWith(`${p}.`))));
}

function readsEveryDifference(differing: string[], checks: readonly StatedIntentCheck[]): boolean {
    const read = fieldReader(differing, checks);
    return differing.length > 0 && differing.every(read);
}

/**
 * Every path the passed assertions read, array indexes included, in the
 * leaves' spelling (`applinks.details[0].appIDs`), and the arrays an `every`
 * with a length or "only" explains whole. Never a substring: a leaf is read
 * when it is such a path or below it by whole segments.
 */
function readPathsOf(checks: readonly StatedIntentCheck[]): string[] {
    const paths = checks.flatMap((c) => c.assertions.flatMap((a) => intentAssertionReads(a).paths)).map((p) => leafPathOf(p));
    const arrays = explainedArrays(checks).map((f) => (f === 'json' ? '$' : f.slice('json.'.length)));
    return [...new Set([...paths, ...arrays])];
}

const isDescribed = (leaf: LeafChange, reads: readonly string[]) => reads.some((p) => p === '$' || isPathUnder(leaf.path, p));

const isJsonField = (f: string) => f === 'json' || f.startsWith('json.');
const isContainer = (text: string | undefined) => {
    const v = text === undefined ? { ok: false as const } : parsed(text);
    return v.ok && v.value !== null && typeof v.value === 'object';
};

/**
 * The leaves behind a finding's differing JSON fields (leaf-changes.ts), split
 * by what the passed assertions read. Only when every differing field is a
 * JSON field and one of them holds an object or an array; else undefined (the
 * finding keeps its field-level line). `fieldRead` fields are described whole
 * and are not walked. The leaves come from the first healthy observer round of
 * each side, the ones the Response tab reads; a leaf the base's own rounds
 * disagree on is left out.
 */
function leafSetOf(
    differing: readonly string[],
    fieldRead: (f: string) => boolean,
    steps: readonly GateStep[],
    reads: readonly string[],
    masked: readonly string[],
    clean?: (text: string) => string,
    spelled?: (leaf: LeafChange) => boolean,
): LeafChangeSet | undefined {
    const unread = differing.filter((f) => !fieldRead(f) && !masked.includes(f));
    if (!unread.length || !differing.every(isJsonField)) return undefined;
    const observer = steps.filter((s) => s.executor === 'observer' && s.transport === 'ok' && s.vmHealth === 'ok' && !s.timedOut).sort((a, b) => a.round - b.round);
    const bases = observer.filter((s) => s.side === 'base');
    const pr = observer.find((s) => s.side === 'pr');
    if (!bases.length || !pr) return undefined;
    if (!unread.some((f) => isContainer(bases[0].fields[f]) || isContainer(pr.fields[f]))) return undefined;
    const leaves: LeafChange[] = [];
    let truncated = false;
    for (const f of unread) {
        const prefix = f === 'json' ? '' : f.slice('json.'.length);
        const exclude = bases.slice(1).flatMap((b) => leafChanges(bases[0].fields[f], b.fields[f], { prefix }).leaves.map((l) => l.path));
        const out = leafChanges(bases[0].fields[f], pr.fields[f], { prefix, exclude, ...(clean ? { clean } : {}) });
        leaves.push(...out.leaves);
        truncated ||= out.truncated;
    }
    if (!leaves.length) return undefined;
    // The diff describes a leaf only when the description names none: once it names the leaves it means,
    // a sibling the diff also changes is not covered by that sentence (a typo in the same object stays the finding).
    const describedBy = (l: LeafChange): LeafDescribedBy | undefined => (isDescribed(l, reads) ? 'description' : !reads.length && spelled?.(l) ? 'diff' : undefined);
    const by = leaves.map((l) => ({ l, by: describedBy(l) }));
    return {
        undescribed: by.filter((x) => !x.by).map((x) => x.l),
        described: by.filter((x) => x.by).map((x) => ({ ...x.l, by: x.by })),
        mentions: reads.slice(0, LEAF_MENTIONS_MAX),
        truncated,
    };
}

/**
 * The leaves of a `behavior_change` finding that no assertion decided on (no
 * stated intent, or one that failed): all undescribed, so the finding names
 * `details[0].paths[0]` and not only `json.applinks.details`. Undefined for
 * anything else, and when its fields are not JSON.
 */
export function leavesOfFinding(decision: VerdictLike, steps: readonly GateStep[], clean?: (text: string) => string, spelled?: (leaf: LeafChange) => boolean): LeafChangeSet | undefined {
    if (decision.verdict !== 'finding' || decision.findingKind !== 'behavior_change') return undefined;
    return leafSetOf(decision.differingFields ?? [], () => false, steps, [], decision.maskedFields ?? [], clean, spelled);
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

/** One field's value, the same on every round given, as canonical JSON elements of an array; else undefined. */
function arrayOn(field: string, steps: readonly GateStep[]): string[] | undefined {
    let out: string[] | undefined;
    for (const s of steps) {
        const v = parsed(s.fields[field]);
        if (!v.ok || !Array.isArray(v.value)) return undefined;
        const elements = v.value.map((x) => JSON.stringify(sortedKeys(x)));
        if (out && JSON.stringify(out) !== JSON.stringify(elements)) return undefined;
        out = elements;
    }
    return out;
}

/**
 * The differing arrays the PR only reorders as its text states (kr-shop #40,
 * "returns order 2 first, then order 1"): on every round the PR answers main's
 * very elements in another order, and a passed assertion reads every position.
 * A changed element, a missing one or a position the text leaves open is not
 * explained.
 */
function reorderedAsStated(differing: string[], steps: readonly GateStep[], prRoundSteps: readonly GateStep[], checks: readonly StatedIntentCheck[]): string[] {
    const base = steps.filter((s) => s.executor === 'observer' && s.side === 'base');
    if (!base.length) return [];
    const reads = checks.flatMap((c) => c.assertions.flatMap((a) => intentAssertionReads(a).paths));
    return differing.filter((f) => {
        if (f !== 'json' && !f.startsWith('json.')) return false;
        const at = f === 'json' ? [] : f.slice('json.'.length).split('.');
        const pr = arrayOn(f, prRoundSteps);
        const main = arrayOn(f, base);
        if (!pr || !main || pr.length < 2 || pr.length !== main.length) return false;
        if (JSON.stringify([...pr].sort()) !== JSON.stringify([...main].sort())) return false;
        const positionRead = (i: number) => reads.some((p) => p.length > at.length && at.every((seg, k) => p[k] === seg) && p[at.length] === i);
        return pr.every((_, i) => positionRead(i));
    });
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
    opts: { mismatch: boolean; pinnedImageId: string; requestBody?: string; clean?: (text: string) => string; spelled?: (leaf: LeafChange) => boolean },
): { decision: D; statedIntents: StatedIntentResult[]; leaves?: LeafChangeSet } {
    const rounds = prRounds(steps, opts.pinnedImageId);
    if (!rounds.length || !checks.length) return { decision, statedIntents: [] };
    const answers = rounds.map((s) => intentAnswerOfFields(s.fields, opts.requestBody));
    // A lent rule that does not hold here is about its own example's value ("9 keyboards: total = subtotal",
    // kr-shop #16): it says nothing of this request, so it neither flags nor explains.
    const evaluated = checks.map((c) => ({ c, r: evaluate(c, answers) })).filter(({ c, r }) => !c.lent || (r.failures.length === 0 && r.inconclusive === 0));
    if (!evaluated.length) return { decision, statedIntents: [] };
    const kept = evaluated.map(({ c }) => c);
    const statedIntents = evaluated.map(({ r }) => r);
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
    const reordered = reorderedAsStated(differing, steps, rounds, kept);
    const notReordered = differing.filter((f) => !reordered.includes(f));
    const fieldRead = fieldReader(notReordered, kept);
    const explains = differing.length > 0 && (notReordered.length === 0 || notReordered.every(fieldRead));
    const isFinding = decision.verdict === 'finding' && decision.findingKind === 'behavior_change' && !pr5xx && allHeld;
    if (isFinding && explains) {
        return { decision: { ...rest, verdict: 'described_change', reason: "every difference from main is what the pull request's own text says, and it held on every PR round" } as D, statedIntents };
    }
    if (!isFinding || differing.length === 0 || reordered.length > 0) return { decision, statedIntents };
    // The fields are compared whole: a path through an array index reads one leaf of one, so the leaves decide.
    const leaves = leafSetOf(notReordered, fieldRead, steps, readPathsOf(kept), decision.maskedFields ?? [], opts.clean, opts.spelled);
    if (!leaves) return { decision, statedIntents };
    if (!leaves.undescribed.length && !leaves.truncated) {
        return { decision: { ...rest, verdict: 'described_change', reason: "every difference from main is what the pull request's own text says, and it held on every PR round" } as D, statedIntents };
    }
    return { decision, statedIntents, leaves };
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
 * A probe with an intent probe of its own request still gets the route's rules
 * of the others: one sentence may read `unitPrice` there and another state
 * `total` for every order (kr-shop #12, release v1f). `failed` holds the intent
 * probes whose assertions failed on their own request.
 */
export function statedIntentChecksFor(
    planned: { probe: Probe; entryPoint: string },
    intents: readonly IntentProbeLike[],
    failed: ReadonlySet<string> = new Set(),
): { checks: StatedIntentCheck[]; explainOnly: boolean } {
    const twins = intents.filter((ip) => sameHttpRequest(planned.probe, ip.probe));
    const routeRules = routeRulesFor(planned, intents, twins, failed);
    if (twins.length) return { checks: [...twins.map((ip) => checkOf(ip)), ...routeRules], explainOnly: false };
    return { checks: routeRules, explainOnly: true };
}

/**
 * The rules over response fields of the other intent probes of the planned
 * probe's method and route, and their status for the same request shape when
 * the text gives that shape one status. When it gives several ("`sofa` is
 * refused with 400 `unknown item`" next to "`keyboard` is still accepted
 * (201)"), the status depends on the value: a status speaks for another value
 * only with the message it quotes, so `laptop` refused with `unknown item` is
 * that refusal (kr-shop #44, release v1l), and a bare status lends nothing.
 * Lent checks that do not hold on the planned answer are dropped there.
 * Never when a sentence of the route failed on its own request: a PR that
 * refuses `keyboard` would answer the refusal's message too.
 */
function routeRulesFor(planned: { probe: Probe; entryPoint: string }, intents: readonly IntentProbeLike[], twins: readonly IntentProbeLike[], failed: ReadonlySet<string>): StatedIntentCheck[] {
    if (planned.probe.spec.kind !== 'http' || planned.entryPoint === 'unmapped') return [];
    const route = planned.entryPoint;
    const method = planned.probe.spec.method;
    const onRoute = intents
        .filter((ip) => ip.probe.spec.kind === 'http' && ip.probe.spec.method === method)
        .filter((ip) => requestMatchesEntryPoint(route, { method, route: routeShapeOf((ip.probe.spec as { path: string }).path) }));
    const sameShape = onRoute.filter((ip) => sameRequestShape(planned.probe, ip.probe));
    const statuses = new Set(sameShape.flatMap((ip) => ip.intentAssertions.flatMap((a) => (a.kind === 'status' ? [a.status] : []))));
    const lendStatus = statuses.size === 1;
    const lendRefusal = statuses.size > 1 && !twins.length && !onRoute.some((ip) => failed.has(ip.probe.id));
    const refusal = (ip: IntentProbeLike) =>
        lendRefusal && sameShape.includes(ip) && ip.intentAssertions.some((a) => a.kind === 'status') && ip.intentAssertions.some((a) => a.kind === 'includes');
    const lent = (ip: IntentProbeLike, a: IntentAssertion) =>
        isRouteInvariant(a) || (a.kind === 'status' && sameShape.includes(ip) && (lendStatus || refusal(ip))) || (a.kind === 'includes' && refusal(ip));
    return onRoute
        .filter((ip) => !twins.includes(ip))
        .map((ip) => ({ ...checkOf(ip, ip.intentAssertions.filter((a) => lent(ip, a))), lent: true }))
        .filter((c) => c.assertions.length > 0);
}
