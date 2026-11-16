import { createHash } from 'crypto';

import { type ReconAnswer, RUN_PLAN_LIMITS, type PlannedProbe } from '@libs/runtime/contracts/run-plan';
import type { EntryPoint } from '@libs/runtime/entry-points';
import { type EnvironmentRuntime, isEnvError } from '@libs/runtime/environment';
import { effectiveCompare, notJsonBodyFields } from '@libs/runtime/gate/probe-fields';
import { redactPatterns } from '@libs/runtime/redaction';

import { type Canary, CanaryLeakError, containsCanary, redactCanaries } from '../canary/canary';
import { isSecurityViolation } from '../run/security-violation';

// The reconnaissance pass (planner-eval.md fix 2, P2 and P8): before the
// replay, each http probe of the plan goes once to the base machine, and what
// it answered (status, media type, the start of the body) shows whether the
// request reaches the app at all and whether its compared fields can show a
// change. A plan with a doubt gets one more planner round to fix its paths
// and its compare, never its expected status: taking the status from base
// would hide every bug base already has, so the worker keeps the status the
// planner first predicted for each probe id.
//
// No reset before or after: the replay resets each side before every round,
// so whatever a probe changes on base here is gone before anything is
// compared.

export const RECON_LIMITS = {
    /** One request per probe (two for a GET, to see whether the body varies), at most this long each. */
    timeoutMs: 15_000,
} as const;

const HTML = /^text\/html\b/i;
const JSON_TYPE = /\bjson\b/i;

const headerOf = (headers: Record<string, string>, name: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
const digest = (body: string) => createHash('sha256').update(body).digest('hex');
/** What the gate compares of a body that is not JSON (an HTML page's text and markup, any other body's digest), or the body's digest. */
const comparedBody = (r: { headers: Record<string, string>; body: string }) => {
    try {
        JSON.parse(r.body);
        return digest(r.body);
    } catch {
        return JSON.stringify(notJsonBodyFields(r.headers, r.body));
    }
};
const requestOf = (p: PlannedProbe) => (p.probe.spec.kind === 'http' ? `${p.probe.spec.method} ${p.probe.spec.path}`.slice(0, 1_100) : p.probe.spec.kind);

/** The doubts one answer raises about its probe; empty when the probe reached the app and its fields can show a change. */
export function reconDoubts(p: PlannedProbe, a: Omit<ReconAnswer, 'doubts'>, entryPoints: Pick<EntryPoint, 'id' | 'added'>[]): string[] {
    if (a.error) return [`base gave no answer (${a.error}): the request may not reach the app`];
    const doubts: string[] = [];
    // A route the PR adds is absent on base by design; anything else answering 404 or 405 is a path or a method the app does not serve.
    const added = entryPoints.some((e) => e.id === p.entryPoint && e.added);
    if ((a.status === 404 || a.status === 405) && !added) doubts.push(`base answered ${a.status}: the app may serve this route under another path (a mount prefix) or method`);
    const html = !!a.contentType && HTML.test(a.contentType);
    const json = !!a.contentType && JSON_TYPE.test(a.contentType);
    if (html) doubts.push('base answered an HTML page: if this is an API route, the request reached the web app instead (a missing mount prefix); if it is a page, it is compared by its visible text and the shape of its markup');
    if (a.varies && !json) doubts.push('two identical requests got different bodies on base (an HTML page: different text or markup): a compare of that body cannot show a change here');
    if (a.bodyIncludesOnBase === false) doubts.push("assertions.bodyIncludes is not in base's body: write the text base shows");
    const compare = effectiveCompare(p.probe);
    if (!json && !html && a.status !== undefined && a.status < 400 && compare.includes('json') && !p.assertions?.bodyIncludes && (a.bodyStart ?? '') !== '')
        doubts.push('the body is not JSON, so it is compared only by its digest');
    return doubts.slice(0, 5);
}

export interface ReconResult {
    answers: ReconAnswer[];
    /** The cell saw the base's code exfiltrate during a recon request. */
    securityViolation?: string;
}

/**
 * Sends each http probe of the plan to the base claim once (a GET twice),
 * cleans what came back (token patterns and the Run's canaries; a canary in
 * an answer stops the Run as on a replay) and reads its doubts.
 */
export async function reconOnBase(args: {
    env: Pick<EnvironmentRuntime, 'probe'>;
    baseClaimId: string;
    probes: PlannedProbe[];
    entryPoints: Pick<EntryPoint, 'id' | 'added'>[];
    stepIdOf: (index: number, n: number) => string;
    canaries: Canary[];
}): Promise<ReconResult> {
    const answers: ReconAnswer[] = [];
    const clean = (text: string) => redactCanaries(redactPatterns(text).text, args.canaries);
    for (const [index, p] of args.probes.entries()) {
        const spec = p.probe.spec;
        if (spec.kind !== 'http') continue;
        const probe = { ...p.probe, spec: { ...spec, timeoutMs: Math.min(spec.timeoutMs ?? RECON_LIMITS.timeoutMs, RECON_LIMITS.timeoutMs) } };
        const times = spec.method === 'GET' || spec.method === 'HEAD' ? 2 : 1;
        const bodies: Array<{ headers: Record<string, string>; body: string }> = [];
        let answer: Omit<ReconAnswer, 'doubts'> = { probeId: p.probe.id, request: clean(requestOf(p)) };
        for (let n = 0; n < times; n++) {
            const r = await args.env.probe(args.baseClaimId, probe, args.stepIdOf(index, n));
            if (isSecurityViolation(r)) return { answers, securityViolation: r.signature };
            if (containsCanary(JSON.stringify(r), args.canaries)) throw new CanaryLeakError('probe_output');
            if (isEnvError(r)) {
                answer = { ...answer, error: r.code };
                break;
            }
            if (!r.http || r.transport !== 'ok') {
                answer = { ...answer, error: r.transport ?? 'no http answer' };
                break;
            }
            bodies.push({ headers: r.http.headers, body: r.http.body });
            if (n === 0) {
                const contentType = headerOf(r.http.headers, 'content-type');
                const includes = p.assertions?.bodyIncludes;
                answer = {
                    ...answer,
                    status: r.http.status,
                    ...(contentType ? { contentType: clean(contentType).slice(0, 200) } : {}),
                    bodyStart: clean(r.http.body.slice(0, RUN_PLAN_LIMITS.reconBodyChars * 2)).slice(0, RUN_PLAN_LIMITS.reconBodyChars),
                    ...(includes ? { bodyIncludesOnBase: r.http.body.includes(includes) } : {}),
                };
            }
        }
        if (bodies.length === 2) answer = { ...answer, varies: comparedBody(bodies[0]) !== comparedBody(bodies[1]) };
        answers.push({ ...answer, doubts: reconDoubts(p, answer, args.entryPoints) });
    }
    return { answers };
}

/**
 * The revised plan's probes, with the status each probe id was first
 * predicted to answer: the reconnaissance round may move a path or change a
 * compare, never the expectation (a status read from base would make every
 * bug base has look expected).
 */
export function keepFirstStatuses(revised: PlannedProbe[], first: PlannedProbe[]): PlannedProbe[] {
    const before = new Map(first.map((p) => [p.probe.id, p.assertions]));
    return revised.map((p) => {
        const was = before.get(p.probe.id);
        if (!was || was.kind !== 'http' || p.probe.spec.kind !== 'http') return p;
        return { ...p, assertions: { ...(p.assertions ?? was), kind: 'http', status: was.status } };
    });
}
