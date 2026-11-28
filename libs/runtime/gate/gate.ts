// The gate is a pure function (ADR-003, ADR-050, ADR-053). It never reads
// text as an instruction: it only compares normalized fields of Steps that the
// observer produced on the pinned image.

import type { FindingKind as SharedFindingKind, ProbeSide, Verdict as SharedVerdict } from '@libs/runtime/contracts/enums';
import { VISUAL_CHANGE_ONLY_REASON } from '@libs/runtime/contracts/enums';

import type { IntendedChange } from './intended-change';

export type { ProbeSide };
/** @deprecated use ProbeSide (the environment's Side also has 'setup'). */
export type Side = ProbeSide;

export interface GateStep {
    stepId: string;
    probeId: string;
    side: ProbeSide;
    round: number;
    executor: 'observer' | 'vm';
    imageId: string;
    transport: 'ok' | 'lost';
    vmHealth: 'ok' | 'oom' | 'crashed' | 'unreachable';
    timedOut: boolean;
    /** Normalized compared fields, e.g. { status: '400', 'json.error': 'cart is empty' }. */
    fields: Record<string, string>;
    /** Whether a demonstrable expectation held; absent when legacy HTTP prose cannot be evaluated. */
    expectedHolds?: boolean;
    /** The observer's request log of this step (S-32): entry-point coverage comes from it. */
    requests?: Array<{ method: string; route: string }>;
    /**
     * The HTTP status the ready check's last try answered right before this
     * round's probe. Absent without a ready check or when it got no answer.
     */
    readyStatus?: number;
    /**
     * The round right after the side's first reset: the app can still be cold for the
     * route (a cache that just restarted, a function not loaded). It stays in the
     * evidence; the gate leaves it out when the warm rounds of the side agree and it
     * alone differs (setAsideColdRounds).
     */
    warmup?: boolean;
}

export type Verdict = SharedVerdict;
export type FindingKind = SharedFindingKind;

export type GateDecision =
    | {
          kind: 'verdict';
          verdict: Verdict;
          reason: string;
          findingKind?: FindingKind;
          differingFields: string[];
          maskedFields: string[];
          /** The cold first rounds the gate set aside because only they differed from the side's warm rounds. */
          coldStart?: Array<{ side: ProbeSide; round: number }>;
          /** The differences the PR's diff spells out (decideIntendedChange): the PR's intended change. */
          intendedChange?: IntendedChange[];
      }
    | { kind: 'more_rounds'; base: number; pr: number; reason: string };

/**
 * The image alias of an environment that was baked: its last bake in the
 * cell, which the cell fixes for each claim when it arrives. Steps then name
 * the concrete image, and the pin is the one they ran on.
 */
export const LATEST_IMAGE = 'latest';

/**
 * The image the steps must all have run on: the pinned one, or for
 * `latest` the image of the first healthy observer step, so base and PR
 * still have to agree on one concrete bake.
 */
function concretePin(pinned: string, steps: GateStep[]): string {
    if (pinned !== LATEST_IMAGE) return pinned;
    const first = steps
        .filter((s) => s.executor === 'observer' && healthy(s))
        .sort((a, b) => (a.side === b.side ? a.round - b.round : a.side === 'base' ? -1 : 1))[0];
    return first?.imageId ?? pinned;
}

export interface GateOptions {
    pinnedImageId: string;
    maxMaskedFields?: number;
    maxRoundsPerSide?: number;
    /** Fields that differ by build, not by behavior; a difference there is not a finding. */
    isVersionSurface?: (field: string) => boolean;
    /**
     * Fields the verdict rests on (the status, the row count, the whole
     * body): one of them varying between base rounds makes the probe
     * inconclusive instead of being masked away.
     */
    isDecisiveField?: (field: string) => boolean;
    /**
     * Fields earlier Runs saw vary on this probe's base (stability.ts, the
     * runtime_stability history): masked as if this Run's base varied on them.
     * Decisive ones make the probe inconclusive; they count toward the masked
     * ceiling; a PR that differs only on one of them is never decided on it.
     */
    knownUnstableFields?: string[];
}

/**
 * Fields that name the build rather than its behavior: a commit or build
 * id, an ETag, an asset hash. Deliberately narrow: `version` or `hash` in a
 * response body can be behavior and stays compared.
 */
export const isBuildIdentityField = (field: string) =>
    /(^|\.)(sha|commit|commit_?sha|git_?sha|build_?id|etag|asset_?hash)$/i.test(field);

/** Top-level kinds (status, exit, db_count, lines, dom, network, console, json): no dot, no sub-path. */
export const isDecisiveField = (field: string) => !field.includes('.');

/**
 * Fields that measure a round against main's baseline round instead of
 * holding a value (a browser probe's pixel diffs, ADR-017). They count only
 * when every round measured them and every round's step outcomes (`steps`)
 * agree: a screen reached by other steps is a different screen, and the step
 * difference is the finding then. A round the cell could not measure is
 * "not measured", never a difference.
 */
export const isMeasureField = (field: string) => field.startsWith('pixels.');

const verdict = (
    v: Verdict,
    reason: string,
    extra: Partial<Extract<GateDecision, { kind: 'verdict' }>> = {},
): GateDecision => ({
    kind: 'verdict',
    verdict: v,
    reason,
    differingFields: [],
    maskedFields: [],
    ...extra,
});

const healthy = (s: GateStep) => s.transport === 'ok' && s.vmHealth === 'ok' && !s.timedOut;
/** A step whose observer answered: transport kept, machine up, no timeout. */
export const healthyStep = healthy;
/** The machine itself failed (not the observer's link to it). */
const machineLost = (s: GateStep) => s.vmHealth !== 'ok' || (s.timedOut && s.transport === 'ok');

/** Why the steps cannot be decided at all, or null. The gate never trusts its caller's bookkeeping. */
function invalidInput(steps: GateStep[], opts: GateOptions, maxRounds: number, maxMasked: number): string | null {
    if (!Number.isInteger(maxRounds) || maxRounds < 2) return 'maxRoundsPerSide must be an integer of at least 2';
    if (!Number.isInteger(maxMasked) || maxMasked < 0) return 'maxMaskedFields must be a non-negative integer';
    if (!opts.pinnedImageId) return 'no image is pinned for the run';
    if (new Set(steps.map((s) => s.probeId)).size > 1) return 'steps of more than one probe were given together';
    const seen = new Set<string>();
    for (const s of steps) {
        if (s.executor !== 'observer') continue;
        if (!Number.isInteger(s.round) || s.round < 1) return `round ${s.round} is not a positive integer`;
        const key = `${s.side}:${s.round}`;
        if (seen.has(key)) return `round ${s.round} of ${s.side} was given twice`;
        seen.add(key);
    }
    return null;
}

/** What a round answered, as the gate compares it: its health, its fields and whether the expectation held. */
const signatureOf = (s: GateStep) => JSON.stringify([healthy(s), s.fields, s.expectedHolds]);

/**
 * Sets aside a side's cold first round (GateStep.warmup) when the side's other rounds
 * agree with each other and it alone differs. With one other round the side cannot yet
 * tell a stable app from a lucky answer: one more round is asked, within the cap.
 * Warm rounds that disagree are kept as they are: that is variance, not a cold start.
 */
function setAsideColdRound(side: GateStep[], maxRounds: number): { steps: GateStep[]; set?: GateStep; more?: boolean } {
    const cold = side.find((s) => s.warmup === true && s.round === 1);
    const warm = side.filter((s) => s !== cold);
    if (!cold || warm.length === 0) return { steps: side };
    if (new Set(warm.map(signatureOf)).size > 1 || signatureOf(cold) === signatureOf(warm[0])) return { steps: side };
    if (warm.length === 1) return side.length < maxRounds ? { steps: side, more: true } : { steps: side };
    return { steps: warm, set: cold };
}

export function decideProbe(steps: GateStep[], opts: GateOptions): GateDecision {
    const note: { coldStart: Array<{ side: ProbeSide; round: number }> } = { coldStart: [] };
    const d = decideRounds(steps, opts, note);
    return d.kind === 'verdict' && note.coldStart.length > 0 ? { ...d, coldStart: note.coldStart } : d;
}

function decideRounds(steps: GateStep[], opts: GateOptions, note: { coldStart: Array<{ side: ProbeSide; round: number }> }): GateDecision {
    const maxMasked = opts.maxMaskedFields ?? 5;
    const maxRounds = opts.maxRoundsPerSide ?? 4;
    const isVersion = opts.isVersionSurface ?? isBuildIdentityField;
    const isDecisive = opts.isDecisiveField ?? isDecisiveField;

    const invalid = invalidInput(steps, opts, maxRounds, maxMasked);
    if (invalid) return verdict('inconclusive', `invalid gate input: ${invalid}`);

    const observer = steps.filter((s) => s.executor === 'observer');
    const pin = concretePin(opts.pinnedImageId, observer);
    // A step that gave no observer output (lost, timed out, machine down) carries no image to check.
    if (observer.some((s) => healthy(s) && s.imageId !== pin)) {
        return verdict('inconclusive', 'a step ran on an image other than the one pinned for the run');
    }

    const bySide = (side: ProbeSide) => observer.filter((s) => s.side === side).sort((a, b) => a.round - b.round);
    const coldBase = setAsideColdRound(bySide('base'), maxRounds);
    const coldPr = setAsideColdRound(bySide('pr'), maxRounds);
    if (coldBase.more || coldPr.more) {
        return { kind: 'more_rounds', base: coldBase.more ? 1 : 0, pr: coldPr.more ? 1 : 0, reason: 'the first round after the reset differs from the only warm round; repeat before deciding' };
    }
    const base = coldBase.steps;
    const pr = coldPr.steps;
    note.coldStart = [coldBase.set, coldPr.set].filter((s): s is GateStep => !!s).map((s) => ({ side: s.side, round: s.round }));
    if (base.length === 0 || pr.length === 0) {
        return verdict('inconclusive', 'no observer step on one side; internal evidence never decides');
    }

    // Rule 5: lost transport, timeout, OOM or crash.
    const baseHealthy = base.every(healthy);
    const prUnhealthy = pr.filter((s) => !healthy(s));
    if (prUnhealthy.length > 0 || !baseHealthy) {
        const prAlwaysLostTheMachine = prUnhealthy.length === pr.length && pr.every(machineLost);
        if (baseHealthy && prAlwaysLostTheMachine && pr.length >= 2) {
            // A finding rests on two healthy base rounds, as every other one does.
            if (base.length < 2) return { kind: 'more_rounds', base: 2 - base.length, pr: 0, reason: 'the base needs two rounds' };
            return verdict('finding', 'the PR side lost the machine in every round while the base stayed healthy', {
                findingKind: 'pr_destabilizes_machine',
            });
        }
        if (baseHealthy && prUnhealthy.length === pr.length && pr.length < maxRounds) {
            return { kind: 'more_rounds', base: 0, pr: 1, reason: 'PR side unhealthy; repeat before deciding' };
        }
        return verdict('inconclusive', 'transport, timeout or machine health failed on both sides, in some rounds only, or only on the link to the observer');
    }

    if (base.length < 2) {
        return { kind: 'more_rounds', base: 2 - base.length, pr: 0, reason: 'the base needs two rounds' };
    }

    // Rule 1: fields where base rounds disagree are masked, unless the verdict rests on them.
    const fields = new Set<string>();
    for (const s of [...base, ...pr]) Object.keys(s.fields).forEach((f) => fields.add(f));
    const rounds = [...base, ...pr];
    const stepsAgree = rounds.every((s) => s.fields.steps === base[0].fields.steps);
    for (const f of [...fields]) if (isMeasureField(f) && (!stepsAgree || rounds.some((s) => !(f in s.fields)))) fields.delete(f);
    const masked = [...fields].filter((f) => new Set(base.map((s) => s.fields[f])).size > 1);
    // Fields the history names that this Run's base happened to agree on are masked too (ADR-050 history).
    const fromHistory = (opts.knownUnstableFields ?? []).filter((f) => fields.has(f) && !masked.includes(f));
    masked.push(...fromHistory);
    const maskedDecisive = masked.filter(isDecisive);
    if (maskedDecisive.length > 0) {
        return verdict('inconclusive', `the base itself varies on ${maskedDecisive.join(', ')}, which the verdict rests on`, { maskedFields: masked });
    }
    if (masked.length > maxMasked) {
        return verdict('inconclusive', `more than ${maxMasked} fields vary between base rounds`, { maskedFields: masked });
    }
    // Fields only the PR's answers carry and that vary between its rounds (a
    // resource the PR now creates: its id, its dates) are masked like the
    // base's own varying fields, but only once a decisive field (the status)
    // already differs from the base on every PR round: the verdict rests on
    // that field, never on the masked ones. With an equal status nothing is
    // masked, so a PR-only value that changes per round still reads as
    // disagreement (demo-kodus-ai#1).
    const stablyDiffers = (f: string) => !masked.includes(f) && pr.every((s) => s.fields[f] === pr[0].fields[f]) && pr[0].fields[f] !== base[0].fields[f];
    const decisiveChange = [...fields].some((f) => isDecisive(f) && !isVersion(f) && stablyDiffers(f));
    const prOnlyVarying = decisiveChange
        ? [...fields].filter((f) => !isDecisive(f) && !masked.includes(f) && base.every((s) => !(f in s.fields)) && new Set(pr.map((s) => s.fields[f])).size > 1)
        : [];
    if (prOnlyVarying.length > 0) masked.push(...prOnlyVarying);
    const compared = [...fields].filter((f) => !masked.includes(f));
    if (compared.filter((f) => !isVersion(f)).length === 0) {
        return verdict('inconclusive', 'no behavior field is left to compare once the varying and build fields are set aside', { maskedFields: masked });
    }

    // A field only the history masks that differs on the PR: the base may vary on it again, or the PR changed it.
    // Neither is told apart by masking it away, so the base plays again and, at the ceiling, the probe stays inconclusive.
    const historyDiffers = fromHistory.filter((f) => !isVersion(f) && pr.some((s) => s.fields[f] !== base[0].fields[f]));
    if (historyDiffers.length > 0) {
        if (base.length < maxRounds) return { kind: 'more_rounds', base: 1, pr: 0, reason: `the PR differs on ${historyDiffers.join(', ')}, which earlier Runs saw vary on the base` };
        return verdict('inconclusive', `the PR differs only where earlier Runs saw the base vary (${historyDiffers.join(', ')})`, { maskedFields: masked });
    }

    const differs = (s: GateStep) =>
        compared.filter((f) => s.fields[f] !== base[0].fields[f] && !isVersion(f));

    // Rule 4: PR rounds that disagree with each other.
    const prSignatures = new Set(pr.map((s) => JSON.stringify(compared.filter((f) => !isVersion(f)).map((f) => s.fields[f]))));
    if (prSignatures.size > 1) {
        // A compared field the base agrees on that differs from the base on
        // every PR round decides, whatever else the PR varies: a broken field
        // next to a per-round nonce is still broken (v-core N1). A field only
        // the PR carries counts only when its value is the same on every PR
        // round; one that varies there (an id, a date) is masked like any
        // other field that varies only between the PR's own rounds.
        const varies = (f: string) => new Set(pr.map((s) => s.fields[f])).size > 1;
        const onBase = (f: string) => base.every((s) => f in s.fields);
        const broken = compared.filter((f) => !isVersion(f) && (onBase(f) || !varies(f)) && pr.every((s) => s.fields[f] !== base[0].fields[f]));
        if (broken.length > 0 && pr.length >= 2) {
            const noise = compared.filter((f) => !broken.includes(f) && varies(f));
            const maskedFields = [...masked, ...noise];
            if (broken.every(isMeasureField)) return verdict('inconclusive', VISUAL_CHANGE_ONLY_REASON, { differingFields: broken, maskedFields });
            return verdict('finding', 'stable base, and the PR differs from it on every round', { findingKind: 'behavior_change', differingFields: broken, maskedFields });
        }
        if (pr.length < maxRounds && base.length < maxRounds) {
            return { kind: 'more_rounds', base: 1, pr: 1, reason: 'PR rounds disagree with each other' };
        }
        return verdict('inconclusive', 'PR rounds keep disagreeing', { maskedFields: masked });
    }

    const diff = differs(pr[0]);
    if (diff.length === 0) {
        if (rounds.some((s) => typeof s.expectedHolds !== 'boolean')) {
            return verdict('inconclusive', 'the expected behavior could not be evaluated on every round', { maskedFields: masked });
        }
        // The probe's own `expected`, read on every round: it must agree within each side.
        const holds = (side: GateStep[]) => (side.every((s) => s.expectedHolds) ? 'holds' : side.every((s) => !s.expectedHolds) ? 'fails' : 'varies');
        const onBase = holds(base);
        const onPr = holds(pr);
        if (onBase === 'varies' || onPr === 'varies') {
            return verdict('inconclusive', 'the expected behavior holds in some rounds and not in others', { maskedFields: masked });
        }
        if (onBase !== onPr) {
            return verdict('inconclusive', 'the expected behavior differs between base and PR, but no compared field shows it', { maskedFields: masked });
        }
        if (onBase === 'fails') {
            return verdict('pre_existing', 'the expected behavior fails the same way on base and PR', { maskedFields: masked });
        }
        return verdict('not_reproduced', 'same result on base and PR', { maskedFields: masked });
    }

    // Rule 3: the PR differs; it must repeat before it becomes a finding.
    if (pr.length < 2) {
        return { kind: 'more_rounds', base: 0, pr: 1, reason: 'the PR differs from the base; repeat it before deciding' };
    }
    // ADR-017: a repeated visual difference is evidence to inspect, not proof
    // of a behavioral regression. Keep the fields for the visual question.
    if (diff.every(isMeasureField)) {
        return verdict('inconclusive', VISUAL_CHANGE_ONLY_REASON, {
            differingFields: diff,
            maskedFields: masked,
        });
    }
    return verdict('finding', 'stable base, stable PR, and they differ', {
        findingKind: 'behavior_change',
        differingFields: diff,
        maskedFields: masked,
    });
}

export interface AgentClaim {
    text: string;
    probeId?: string;
}

/**
 * What the agent says it proved but no healthy observer step on the pinned
 * image backs becomes `unverified` (ADR-038). The agent's words never create
 * a finding. Without `pinnedImageId` any image counts (the old contract).
 */
export function markUnbackedClaims(
    claims: AgentClaim[],
    steps: GateStep[],
    opts: { pinnedImageId?: string } = {},
): Array<AgentClaim & { backedByProbe: boolean; verdict?: 'unverified' }> {
    const pin = opts.pinnedImageId ? concretePin(opts.pinnedImageId, steps) : undefined;
    const backed = new Set(
        steps
            .filter((s) => s.executor === 'observer' && healthy(s) && (!pin || s.imageId === pin))
            .map((s) => s.probeId),
    );
    return claims.map((c) =>
        c.probeId && backed.has(c.probeId)
            ? { ...c, backedByProbe: true }
            : { ...c, backedByProbe: false, verdict: 'unverified' as const },
    );
}

/** @deprecated use markUnbackedClaims. */
export const checkClaims = markUnbackedClaims;

/** How a framework answers a route it does not have. */
const ROUTE_ABSENT = new Set(['404', '405']);
const statusOf = (s: GateStep) => (s.fields.status !== undefined && /^\d{3}$/.test(s.fields.status) ? Number(s.fields.status) : undefined);
/** The base app was up and routing in this round: its health path answered 2xx or 3xx just before the probe. */
const baseAnsweredReady = (s: GateStep) => s.readyStatus !== undefined && s.readyStatus >= 200 && s.readyStatus < 400;

/**
 * A route the PR adds is new behavior, not a regression (ADR-038 verdicts,
 * decision of 2026-11-12). It turns a `behavior_change` finding
 * into `new_endpoint` only when all of these hold, and otherwise returns the
 * decision unchanged:
 *
 * - the diff adds the route the probe covered (`addedByDiff`: its
 *   declaration is an added line, entry-points/extract.ts);
 * - the status is one of the differing fields;
 * - every base round answered 404 or 405, and in every base round the ready
 *   check answered 2xx or 3xx first, so main was booted, ready and routing and
 *   only lacked the route (a broken base that answers 404 everywhere fails
 *   its ready check and stays a finding);
 * - every PR round answered with a status other than 404 or 405.
 *
 * A PR answer of 5xx stays a finding, of kind `new_endpoint_error`: the new
 * code fails, which no base comparison is needed to say. A route the PR
 * removes (main answers, the PR 404s) is never `addedByDiff` and stays a
 * regression.
 *
 * Main failing on the request is the same case: every base round answered
 * 5xx after a ready check, as when another route swallows the path the PR
 * declares (`/orders/:id` takes `/orders/search` and fails, kr-shop #36).
 * The PR answering it without a 5xx is new behavior; a PR that fails too
 * stays the finding it was.
 */
export function decideNewEndpoint<D extends GateDecision>(decision: D, steps: GateStep[], opts: { addedByDiff: boolean }): D {
    if (decision.kind !== 'verdict' || decision.verdict !== 'finding' || decision.findingKind !== 'behavior_change') return decision;
    if (!opts.addedByDiff) return decision;
    const observer = steps.filter((s) => s.executor === 'observer');
    const base = observer.filter((s) => s.side === 'base');
    const pr = observer.filter((s) => s.side === 'pr');
    if (base.length === 0 || pr.length === 0) return decision;
    const prStatuses = pr.map(statusOf);
    const failsOnBase = base.every((s) => (statusOf(s) ?? 0) >= 500 && baseAnsweredReady(s));
    if (failsOnBase) {
        if (prStatuses.some((s) => s === undefined || s >= 500)) return decision;
        const { findingKind: _kind, ...rest } = decision;
        const prSays = [...new Set(prStatuses)].join('/');
        return { ...rest, verdict: 'new_endpoint', reason: `main fails on this request (${base[0].fields.status}) and the route this PR adds answers it (${prSays}): new behavior, not a regression` } as D;
    }
    const absentOnBase = base.every((s) => ROUTE_ABSENT.has(s.fields.status ?? '') && baseAnsweredReady(s));
    // A PR that answers 404 or 405 too (a missing order on a route it adds, kr-shop #20) answers in its own words, where
    // main answers its framework's: main has no such route to compare with.
    if (!absentOnBase || prStatuses.some((s) => s === undefined)) return decision;
    const mainSays = base[0].fields.status;
    const prSays = [...new Set(prStatuses)].join('/');
    if (prStatuses.some((s) => s! >= 500)) {
        return { ...decision, findingKind: 'new_endpoint_error', reason: `a route this PR adds answers ${prSays} on the PR; main has no such route (${mainSays})` } as D;
    }
    const { findingKind: _kind, ...rest } = decision;
    return { ...rest, verdict: 'new_endpoint', reason: `main has no such route (${mainSays}) and this PR answers it (${prSays}): new behavior, not a regression` } as D;
}
