import { classifyBlocker, type BlockerInput } from '@libs/runtime/blockers/catalog';
import { BLOCKER_KINDS, type BlockerKind } from '@libs/runtime/contracts/enums';
import type { GateStep } from '@libs/runtime/gate';
import { BROWSER_STEP_KINDS } from '@libs/runtime/probe/probe.schema';
import type { Observed, ProbeVerdict, ReportBrowserStep, ReportPath, RunState, RuntimeRunReport, RuntimeRunRequested, Uncovered, VerdictState } from '@libs/runtime/run';
import type { RunBootFailure } from '@libs/runtime/run/boot-failure';

import { PIXEL_CHANGE_THRESHOLD } from './probe-fields';

// The structured result the product renders into the comment, the replies and
// the check (ADR-052). Only fields the gate and the replay produced: verdicts,
// entry points, probe ids, HTTP status or exit code per side. Never the body
// of a response, the agent's prose or a test's output.

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/** What one side answered on its first round: the normalized status, the exit code, or a browser probe's steps passed. */
export function observedOf(steps: GateStep[], stepIds: string[] | undefined): Observed | undefined {
    const step = steps.find((s) => stepIds?.includes(s.stepId));
    if (!step) return undefined;
    if (step.transport === 'lost') return { transport: 'lost' };
    const status = Number(step.fields.status);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return { status };
    const exit = Number(step.fields.exitCode ?? step.fields.exit_code);
    if (Number.isInteger(exit) && exit >= -1 && exit <= 255) return { exitCode: exit };
    const browser = browserStepsOf(step.fields.steps);
    if (browser) return { browser };
    return undefined;
}

/** The `steps` field of a browser round (probe-fields.ts: `ok` or `fail:<why>` per step, comma-joined) as steps passed of total. */
function browserStepsOf(field: string | undefined): Observed['browser'] {
    if (!field) return undefined;
    const tokens = field.split(',');
    if (tokens.length > 100 || !tokens.every((t) => t === 'ok' || /^fail:[a-z_]+$/.test(t))) return undefined;
    return { passed: tokens.filter((t) => t === 'ok').length, total: tokens.length };
}

/**
 * A browser probe's finding in the report's own terms (ADR-071), from the
 * verdict's lanes: the first step the gate's difference rests on (its
 * outcome when the gate differs in `steps`, its value when it differs in
 * `step.N.value`), named by the probe's step, never by what the page held;
 * and the largest pixel change of the PR's screenshots against main's. The
 * values the steps read only decide which step it is; none reaches the report.
 */
export function browserFindingOf(p: Pick<ProbeVerdict, 'lanes' | 'differingFields'>): Pick<ReportPath, 'browserStep' | 'pixelDiffPercent'> {
    const base = p.lanes?.base.browser;
    const pr = p.lanes?.pr.browser;
    if (!base || !pr) return {};
    const differing = new Set(p.differingFields ?? []);
    let browserStep: ReportBrowserStep | undefined;
    for (let i = 0; i < Math.max(base.steps.length, pr.steps.length) && !browserStep; i++) {
        const a = base.steps[i];
        const b = pr.steps[i];
        const at = (b ?? a)!;
        const index = at.index;
        const outcomeDiffers = !a || !b || a.ok !== b.ok || (a.error ?? '') !== (b.error ?? '');
        const valueDiffers = !!a && !!b && a.ok && b.ok && (a.value ?? '') !== (b.value ?? '');
        let outcome: ReportBrowserStep['outcome'] | undefined;
        if (outcomeDiffers && differing.has('steps')) outcome = a?.ok ? 'fails_on_pr' : b?.ok ? 'fails_on_main' : 'fails_differently';
        else if (valueDiffers && differing.has(`step.${index}.value`)) outcome = 'value_differs';
        if (!outcome || !Number.isInteger(index) || index < 0 || index > 99 || !(BROWSER_STEP_KINDS as readonly string[]).includes(at.kind)) continue;
        const target = (b?.target ?? a?.target)?.slice(0, 128);
        browserStep = { index, kind: at.kind, ...(target ? { target } : {}), outcome };
    }
    const ratio = Math.max(0, ...pr.steps.map((s) => (typeof s.ratio === 'number' && Number.isFinite(s.ratio) ? s.ratio : 0)));
    const pixelDiffPercent = ratio > PIXEL_CHANGE_THRESHOLD ? Math.min(100, Math.round(ratio * 1000) / 10) : undefined;
    return { ...(browserStep ? { browserStep } : {}), ...(pixelDiffPercent !== undefined ? { pixelDiffPercent } : {}) };
}

const UNCOVERED_FROM_VERDICT: Partial<Record<ProbeVerdict['verdict'], Uncovered['reason']>> = {
    inconclusive: 'inconclusive',
    blocker: 'blocker',
    unverified: 'unverified',
};

export function buildReport(args: {
    req: Pick<RuntimeRunRequested, 'requestedAt' | 'trigger'> & { headSha: string };
    state: RunState;
    verdictState?: VerdictState;
    probes: ProbeVerdict[];
    steps: GateStep[];
    uncovered: string[];
    blockedOutbound?: Array<{ host: string; port?: number }>;
    dependencyChangeUntested?: boolean;
    bootMs?: number;
    commands?: number;
    cellOwner?: 'kodus' | 'customer';
    securityEvent?: boolean;
    securityViolation?: { side: 'base' | 'pr'; signature: string };
    /** The Run stopped early (halted): what has no verdict was not reached. */
    stoppedEarly?: boolean;
    /** Recipe files the PR changes (S-19); the comment says the base's recipe ran. */
    recipeChangedInPr?: RuntimeRunReport['recipeChangedInPr'];
    /** The projection's `uncovered`, when the Run wrote it: used as is instead of recomputing from the probes. */
    uncoveredDetail?: Uncovered[];
    /** The projection's boot failure: only its error line reaches the report. */
    bootFailure?: RunBootFailure;
}): RuntimeRunReport {
    const paths = args.probes.slice(0, 100).map((p) => ({
        entryPoint: clip(p.entryPoint || 'unknown', 512),
        probeId: clip(p.probeId || 'probe', 128),
        ...(p.exercised ? { exercised: clip(p.exercised, 256) } : {}),
        ...(p.via ? { via: clip(p.via, 512) } : {}),
        verdict: p.verdict,
        ...(p.findingKind ? { findingKind: p.findingKind } : {}),
        ...(p.intent ? { intent: p.intent } : {}),
        ...withSide('base', observedOf(args.steps, p.baseStepIds)),
        ...withSide('pr', observedOf(args.steps, p.prStepIds)),
        ...(p.differingFields?.length ? { differingFields: p.differingFields.slice(0, 5).map((f) => clip(f, 128)) } : {}),
        ...browserFindingOf(p),
        ...(p.suggestionId && SUGGESTION_ID.test(p.suggestionId) ? { suggestionId: p.suggestionId } : {}),
    }));
    // The projection's own list when the Run wrote one (a boot blocker names its cause there), so the comment and the page agree.
    const uncovered = args.uncoveredDetail?.length ? args.uncoveredDetail.slice(0, 100) : uncoveredOf(args.probes, args.uncovered, args.stoppedEarly);
    return {
        state: args.state,
        ...(args.verdictState ? { verdictState: args.verdictState } : {}),
        headSha: args.req.headSha,
        requestedAt: args.req.requestedAt,
        ...(args.req.trigger ? { trigger: args.req.trigger } : {}),
        ...(args.bootMs !== undefined ? { bootMs: Math.max(0, Math.round(args.bootMs)) } : {}),
        paths,
        uncovered,
        blockedOutbound: (args.blockedOutbound ?? []).slice(0, 20).map((h) => ({ host: clip(h.host, 253), ...(h.port ? { port: h.port } : {}) })),
        ...(args.dependencyChangeUntested ? { dependencyChangeUntested: true } : {}),
        ...(args.commands !== undefined ? { commands: args.commands } : {}),
        ...(args.cellOwner ? { cellOwner: args.cellOwner } : {}),
        ...(args.securityEvent ? { securityEvent: true } : {}),
        ...(args.securityViolation ? { securityViolation: args.securityViolation } : {}),
        ...(args.recipeChangedInPr?.length ? { recipeChangedInPr: args.recipeChangedInPr } : {}),
        ...bootFailureOf(args.state, uncovered),
        ...bootErrorOf(args.bootFailure),
    };
}

/** The boot failure's error line as the report carries it: one line, at most 300 characters. */
function bootErrorOf(f: RunBootFailure | undefined): Pick<RuntimeRunReport, 'bootError'> {
    const line = f?.errorLine?.replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
    return f && line ? { bootError: { side: f.side, line } } : {};
}

/**
 * The entry points a Run decides on: the diff's, with each `unmapped:<file>`
 * the agent reached through a route (`via`) replaced by that route. The route
 * is then covered, or not, by the observer's log like any other (S-32); a file
 * the agent found no route for stays unmapped and uncovered.
 */
export function entryPointsWithRoutes(entryPoints: string[], planned: { entryPoint: string; via?: string }[]): string[] {
    const routesOf = new Map<string, string[]>();
    for (const p of planned) {
        if (!p.via) continue;
        const routes = routesOf.get(`unmapped:${p.via}`) ?? [];
        if (!routes.includes(p.entryPoint)) routes.push(p.entryPoint);
        routesOf.set(`unmapped:${p.via}`, routes);
    }
    const out: string[] = [];
    for (const e of entryPoints) for (const id of routesOf.get(e) ?? [e]) if (!out.includes(id)) out.push(id);
    return out;
}

/**
 * Why each entry point could not be cleared: an undecided comparison or an
 * existing failure, else not reached (the Run stopped early) or no probe.
 * The report and the Run projection both carry it, so the PR comment and the
 * Run page say the same thing.
 */
export function uncoveredOf(probes: ProbeVerdict[], entryPoints: string[], stoppedEarly?: boolean): Uncovered[] {
    return entryPoints.slice(0, 100).map((entryPoint) => {
        const probe = probes.find((p) => p.entryPoint === entryPoint && UNCOVERED_FROM_VERDICT[p.verdict]);
        const preExisting = probes.some((p) => p.entryPoint === entryPoint && p.verdict === 'pre_existing');
        const reason: Uncovered['reason'] = probe ? UNCOVERED_FROM_VERDICT[probe.verdict]! : preExisting ? 'pre_existing' : stoppedEarly ? 'not_reached' : 'no_probe';
        const blocker = reason === 'blocker' ? validBlocker(probe?.blocker) : undefined;
        return { entryPoint: clip(entryPoint, 512), reason, ...(blocker ? { blocker } : {}) };
    });
}

/** What the comment and the page may name: a variable name only, never a value (run-report.ts UncoveredSchema). */
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SUGGESTION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function validBlocker(b: ProbeVerdict['blocker']): Uncovered['blocker'] {
    if (!b || !(BLOCKER_KINDS as readonly string[]).includes(b.kind)) return undefined;
    return { kind: b.kind, ...(b.kind === 'missing_env' && b.name && ENV_NAME.test(b.name) ? { name: b.name } : {}) };
}

/**
 * The structured cause of a boot the cell reported blocked: the first blocker
 * the catalog classifies (docs §4, deterministic rules), as a report kind and,
 * for missing_env, the variable it names. The catalog's own kinds that the
 * report does not know (not_ready) read as unknown.
 */
export function bootBlockerOf(blockers: BlockerInput[]): { kind: BlockerKind; name?: string } | undefined {
    const first = blockers[0];
    if (!first) return undefined;
    const c = classifyBlocker({ kind: first.kind, signature: first.signature, message: first.message, ...(first.bundle ? { bundle: first.bundle } : {}) });
    const kind: BlockerKind = (BLOCKER_KINDS as readonly string[]).includes(c.kind) ? (c.kind as BlockerKind) : 'unknown';
    const name = kind === 'missing_env' ? c.signature.replace(/^missing_env:/, '') : undefined;
    return { kind, ...(name && ENV_NAME.test(name) ? { name } : {}) };
}

/**
 * A boot blocker of the PR's side that is not a proven defect of the PR: the
 * cell ran out of memory or disk (builds share the cell), a platform fault, or
 * a host the sandbox does not reach (the PR's build or boot needs it, e.g. a
 * Go checksum lookup for a new dependency). Such a boot is never a finding
 * against the PR (a false regression is worse than an untested path); the
 * PR's paths stay untested with that cause.
 */
export function infraBootBlocker(blockers: BlockerInput[]): boolean {
    const kind = bootBlockerOf(blockers)?.kind;
    return kind === 'resources' || kind === 'platform' || kind === 'external_service';
}

/** could_not_boot is written only when the base's boot is blocked (run-orchestrator.ts): its cause is the uncovered paths' blocker. */
function bootFailureOf(state: RunState, uncovered: Uncovered[]): Pick<RuntimeRunReport, 'bootFailure'> {
    const kind = uncovered.find((u) => u.reason === 'blocker' && u.blocker)?.blocker?.kind;
    return state === 'could_not_boot' && kind ? { bootFailure: { failsOnBase: true, kind } } : {};
}

/** Every entry point of a Run whose base could not boot: not tested, because of that blocker. */
export function uncoveredByBoot(entryPoints: string[], blocker: { kind: BlockerKind; name?: string } | undefined): Uncovered[] {
    return entryPoints.slice(0, 100).map((entryPoint) => ({ entryPoint: clip(entryPoint, 512), reason: 'blocker' as const, ...(validBlocker(blocker) ? { blocker: validBlocker(blocker)! } : {}) }));
}

const withSide = (side: 'base' | 'pr', o: Observed | undefined) => (o ? { [side]: o } : {});
