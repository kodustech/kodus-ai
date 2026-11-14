// The gate is a pure function (ADR-003, ADR-050, ADR-053). It never reads
// text as an instruction: it only compares normalized fields of Steps that the
// observer produced on the pinned image.

import type { FindingKind as SharedFindingKind, ProbeSide, Verdict as SharedVerdict } from '@libs/runtime/contracts/enums';
import { VISUAL_CHANGE_ONLY_REASON } from '@libs/runtime/contracts/enums';

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
}

/**
 * Fields that name the build rather than its behavior: a commit or build
 * id, an ETag, an asset hash. Deliberately narrow: `version` or `hash` in a
 * response body can be behavior and stays compared.
 */
export const isBuildIdentityField = (field: string) =>
    /(^|\.)(sha|commit|commit_?sha|git_?sha|build_?id|etag|asset_?hash)$/i.test(field);

/** @deprecated use isBuildIdentityField. */
export const DEFAULT_VERSION_SURFACE = isBuildIdentityField;

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

export function decideProbe(steps: GateStep[], opts: GateOptions): GateDecision {
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

    const base = observer.filter((s) => s.side === 'base').sort((a, b) => a.round - b.round);
    const pr = observer.filter((s) => s.side === 'pr').sort((a, b) => a.round - b.round);
    if (base.length === 0 || pr.length === 0) {
        return verdict('inconclusive', 'no observer step on one side; internal evidence never decides');
    }

    // Rule 5: lost transport, timeout, OOM or crash.
    const baseHealthy = base.every(healthy);
    const prUnhealthy = pr.filter((s) => !healthy(s));
    if (prUnhealthy.length > 0 || !baseHealthy) {
        const prAlwaysLostTheMachine = prUnhealthy.length === pr.length && pr.every(machineLost);
        if (baseHealthy && prAlwaysLostTheMachine && pr.length >= 2) {
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
    const maskedDecisive = masked.filter(isDecisive);
    if (maskedDecisive.length > 0) {
        return verdict('inconclusive', `the base itself varies on ${maskedDecisive.join(', ')}, which the verdict rests on`, { maskedFields: masked });
    }
    if (masked.length > maxMasked) {
        return verdict('inconclusive', `more than ${maxMasked} fields vary between base rounds`, { maskedFields: masked });
    }
    const compared = [...fields].filter((f) => !masked.includes(f));
    if (compared.filter((f) => !isVersion(f)).length === 0) {
        return verdict('inconclusive', 'no behavior field is left to compare once the varying and build fields are set aside', { maskedFields: masked });
    }

    const differs = (s: GateStep) =>
        compared.filter((f) => s.fields[f] !== base[0].fields[f] && !isVersion(f));

    // Rule 4: PR rounds that disagree with each other.
    const prSignatures = new Set(pr.map((s) => JSON.stringify(compared.filter((f) => !isVersion(f)).map((f) => s.fields[f]))));
    if (prSignatures.size > 1) {
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
