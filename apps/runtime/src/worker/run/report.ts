import { classifyBlocker, type BlockerInput } from '@libs/runtime/blockers/catalog';
import { BLOCKER_KINDS, type BlockerKind } from '@libs/runtime/contracts/enums';
import { REPOSITORY_ALIAS_PATTERN } from '@libs/runtime/contracts/workspace';
import type { GateStep } from '@libs/runtime/gate';
import { PIXEL_CHANGE_THRESHOLD } from '@libs/runtime/gate/probe-fields';
import { BROWSER_STEP_KINDS } from '@libs/runtime/probe/probe.schema';
import type { Observed, ProbeVerdict, ReportBrowserStep, ReportPath, RunState, RuntimeRunReport, RuntimeRunRequested, Uncovered, VerdictState } from '@libs/runtime/run';
import type { RunBootFailure } from '@libs/runtime/run/boot-failure';
import { isKeptCheckNotRun, KEPT_CHECK_SOURCE, type KeptCheckOutcome, MAX_KEPT_CHECKS_PER_REPOSITORY } from '@libs/runtime/contracts/kept-check';
import { BOOT_BLOCKER_CAUSES, type BootBlockerCause } from '@libs/runtime/run/run-report';

// The structured result the product renders into the comment, the replies and
// the check. Only fields the gate and the replay produced: verdicts,
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

/** The `steps` field of a browser round (gate/probe-fields.ts: `ok` or `fail:<why>` per step, comma-joined) as steps passed of total. */
function browserStepsOf(field: string | undefined): Observed['browser'] {
    if (!field) return undefined;
    const tokens = field.split(',');
    if (tokens.length > 100 || !tokens.every((t) => t === 'ok' || /^fail:[a-z_]+$/.test(t))) return undefined;
    return { passed: tokens.filter((t) => t === 'ok').length, total: tokens.length };
}

/**
 * A browser probe's finding in the report's own terms, from the
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

/** The report's kept checks: how many were played and failed, and each one that could not run as kept. */
function keptChecksOf(outcomes: KeptCheckOutcome[]): NonNullable<RuntimeRunReport['keptChecks']> {
    const list = outcomes.slice(0, MAX_KEPT_CHECKS_PER_REPOSITORY);
    return {
        played: list.filter((o) => o.probeId).length,
        failed: list.filter((o) => o.outcome === 'failed').length,
        notRun: list.filter(isKeptCheckNotRun),
    };
}

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
    /** Recipe files the PR changes; the comment says the base's recipe ran. */
    recipeChangedInPr?: RuntimeRunReport['recipeChangedInPr'];
    /** The member repository the PR is in, when its `.kodus/` changes were not applied. */
    recipeChangedInMember?: string;
    /** The projection's `uncovered`, when the Run wrote it: used as is instead of recomputing from the probes. */
    uncoveredDetail?: Uncovered[];
    /** The projection's boot failure: only its error line reaches the report. */
    bootFailure?: RunBootFailure;
    /** nothing_to_test: the files judged to change nothing that runs. */
    noRuntimeEffect?: { file: string }[];
    /** The projection's coldBuild: a side that built with no cache because the cell had evicted the environment's state. */
    coldBuild?: RuntimeRunReport['coldBuild'];
    /** The projection's exercised: which changed lines the PR side ran (claim.exercised). */
    exercised?: RuntimeRunReport['exercised'];
    /** The projection's keptChecks: what the Run made of each kept check it carried. */
    keptChecks?: KeptCheckOutcome[];
    /** The request's partlyTestedCheck: the org's choice for a partly tested Run with something left to decide. */
    partlyTestedCheck?: RuntimeRunReport['partlyTestedCheck'];
}): RuntimeRunReport {
    const paths = args.probes.slice(0, 100).map((p) => ({
        entryPoint: clip(p.entryPoint || 'unknown', 512),
        probeId: clip(p.probeId || 'probe', 128),
        ...(p.exercised ? { exercised: clip(p.exercised, 256) } : {}),
        ...(p.via ? { via: clip(p.via, 512) } : {}),
        verdict: p.verdict,
        ...(p.findingKind ? { findingKind: p.findingKind } : {}),
        ...(p.intent ? { intent: p.intent } : {}),
        ...(p.verdict === 'finding' && p.intent === 'intended' ? { intendedBy: p.intendedChange?.length ? ('diff' as const) : ('test' as const) } : {}),
        ...withSide('base', observedOf(args.steps, p.baseStepIds)),
        ...withSide('pr', observedOf(args.steps, p.prStepIds)),
        ...(p.differingFields?.length ? { differingFields: p.differingFields.slice(0, 5).map((f) => clip(f, 128)) } : {}),
        ...browserFindingOf(p),
        ...(p.suggestionId && SUGGESTION_ID.test(p.suggestionId) ? { suggestionId: p.suggestionId } : {}),
        ...(p.source === KEPT_CHECK_SOURCE && p.keptCheckId ? { source: KEPT_CHECK_SOURCE, keptCheckId: p.keptCheckId } : {}),
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
        ...(args.recipeChangedInPr?.length && args.recipeChangedInMember && REPOSITORY_ALIAS_PATTERN.test(args.recipeChangedInMember) ? { recipeChangedInMember: args.recipeChangedInMember } : {}),
        ...bootFailureOf(args.state, uncovered, args.bootFailure),
        ...bootErrorOf(args.bootFailure),
        ...(args.coldBuild && !Number.isNaN(Date.parse(args.coldBuild.evictedAt))
            ? { coldBuild: { side: args.coldBuild.side, cause: 'build_state_evicted' as const, evictedAt: new Date(args.coldBuild.evictedAt).toISOString() } }
            : {}),
        ...(args.exercised ? { exercised: args.exercised } : {}),
        ...(args.keptChecks?.length ? { keptChecks: keptChecksOf(args.keptChecks) } : {}),
        ...(args.state === 'nothing_to_test' && args.noRuntimeEffect?.length ? { noRuntimeEffect: args.noRuntimeEffect.slice(0, 20).map((f) => clip(f.file, 512)) } : {}),
        ...(args.partlyTestedCheck ? { partlyTestedCheck: args.partlyTestedCheck } : {}),
        ...prEgressDeniedOf(args.state, args.bootFailure),
    };
}

/** A PR boot the egress proxy stopped (bootFailure.deniedHosts): the hosts the check asks to approve. Never on a regression. */
function prEgressDeniedOf(state: RunState, f: RunBootFailure | undefined): Pick<RuntimeRunReport, 'prEgressDenied'> {
    if (state === 'regression' || f?.side !== 'pr' || !f.deniedHosts?.length) return {};
    return { prEgressDenied: { hosts: f.deniedHosts.slice(0, 5).map((h) => clip(h, 253)) } };
}

/** The boot failure's error line as the report carries it: one line, at most 300 characters. */
function bootErrorOf(f: RunBootFailure | undefined): Pick<RuntimeRunReport, 'bootError'> {
    const line = f?.errorLine?.replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
    return f && line ? { bootError: { side: f.side, line } } : {};
}

/**
 * The entry points a Run decides on: the diff's, with each `unmapped:<file>`
 * the agent reached through a route (`via`) replaced by that route. The route
 * is then covered, or not, by the observer's log like any other; a file
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

function validBlocker(b: (ProbeVerdict['blocker'] & { cause?: string }) | undefined): Uncovered['blocker'] {
    if (!b || !(BLOCKER_KINDS as readonly string[]).includes(b.kind)) return undefined;
    const cause = (BOOT_BLOCKER_CAUSES as readonly string[]).includes(b.cause ?? '') ? (b.cause as BootBlockerCause) : undefined;
    return { kind: b.kind, ...(b.kind === 'missing_env' && b.name && ENV_NAME.test(b.name) ? { name: b.name } : {}), ...(cause ? { cause } : {}) };
}

/**
 * The structured cause of a boot the cell reported blocked: the first blocker
 * the catalog classifies (deterministic rules), as a report kind and,
 * for missing_env, the variable it names. The catalog's own kinds that the
 * report does not know (not_ready) read as unknown.
 */
export function bootBlockerOf(blockers: BlockerInput[], buildStateEvictedAt?: string): { kind: BlockerKind; name?: string; cause?: BootBlockerCause } | undefined {
    const first = blockers[0];
    if (!first) return undefined;
    const c = classifyBlocker({ kind: first.kind, signature: first.signature, message: first.message, ...(first.bundle ? { bundle: first.bundle } : {}) });
    const kind: BlockerKind = (BLOCKER_KINDS as readonly string[]).includes(c.kind) ? (c.kind as BlockerKind) : 'unknown';
    const name = kind === 'missing_env' ? c.signature.replace(/^missing_env:/, '') : undefined;
    // A boot that outlived its wait is no machine out of resources (demo-calcom#2 said so); one whose build
    // ran cold because the cell had evicted the environment's build state says that instead.
    const timedOut = first.signature === 'boot_timeout';
    const cause: BootBlockerCause | undefined = timedOut ? (buildStateEvictedAt ? 'build_state_evicted' : 'boot_timeout') : undefined;
    return { kind, ...(name && ENV_NAME.test(name) ? { name } : {}), ...(cause ? { cause } : {}) };
}

/**
 * The signatures the cell or the hub sets about itself: a Kodus step of the
 * claim, the cell or its connection gone, the cell's own disk watchdog, the
 * builder dying outside the build's steps, or no room or size to place the
 * claim. The PR's code cannot produce any of them; it can write any log line,
 * exit with any code, use any memory or disk and take any time.
 */
const CELL_FAULT_SIGNATURES: ReadonlySet<string> = new Set([
    // Kodus's own steps of a claim (blockers/rules/declared.ts PLATFORM_STEPS), and the cell's agent.
    'org_key',
    'claim_keys',
    'claim_network',
    'create_workload',
    'create_observer',
    'restore_workload',
    'repo_source',
    'repo_fetch',
    'repo_upload',
    'workdir',
    'egress_policy',
    'guest_agent',
    'claim_ready_refused',
    'resource_cleanup_pending',
    'resource_enforcement_unavailable',
    'sql_provision_failed',
    // The image the cell builds and loads: a builder that ended with no step failed, a load the host refused.
    'builder_failed',
    'image_load',
    // The cell itself: lost, unavailable, its disk under the floor for every claim.
    'cell_lost',
    'cell_unavailable',
    'cell_disk_full',
    // The hub's placement and admission: no cell, no room, no size, no minutes.
    'no_capacity',
    'org_capacity',
    'machine_minutes_exhausted',
    'size_unavailable',
    'memory_unavailable',
    'isolation_unavailable',
    'backend_unavailable',
    'host_unavailable',
    'admission_deadline',
    'environment_not_prepared',
    'build_state_evicted',
]);

/** One blocker the cell or the hub declared about itself: its signature alone, never the text it carries. */
const isCellFault = (b: BlockerInput, buildStateEvictedAt: string | undefined) =>
    CELL_FAULT_SIGNATURES.has(b.signature) ||
    // A boot that outlived its wait while building cold, because the cell had evicted the environment's build state.
    (b.signature === 'boot_timeout' && !!buildStateEvictedAt);

/**
 * A PR side that did not boot, while the base did, for a cause outside the
 * PR's control: every blocker of the side is one the cell or the hub declared
 * about itself (CELL_FAULT_SIGNATURES), or a boot that timed out building
 * cold on a build state the cell evicted. Such a boot is never a finding
 * against the PR; its paths stay untested with that cause.
 *
 * Anything else is the PR's (pr_destabilizes_machine): the PR's build and
 * service output, the reason the cell quotes from it, an exit code, memory or
 * disk the workload used at the machine size the base booted with, and the
 * time it took. The PR writes or drives all of those, so a line such as
 * "JavaScript heap out of memory" or "ECONNREFUSED" never excuses it
 * (s1-security-crosscut S1-01).
 */
export function infraBootBlocker(side: { blockers: BlockerInput[]; buildStateEvictedAt?: string }): boolean {
    return side.blockers.length > 0 && side.blockers.every((b) => isCellFault(b, side.buildStateEvictedAt));
}

/** could_not_boot is written only when the base's boot is blocked (run-orchestrator.ts): its cause is the uncovered paths' blocker. */
function bootFailureOf(state: RunState, uncovered: Uncovered[], boot?: RunBootFailure): Pick<RuntimeRunReport, 'bootFailure'> {
    const kind = uncovered.find((u) => u.reason === 'blocker' && u.blocker)?.blocker?.kind;
    if (state !== 'could_not_boot' || !kind) return {};
    // Both sides came up; the cell had no prepared image of the environment (run-orchestrator.ts).
    if (boot?.signature === 'environment_not_prepared') return { bootFailure: { failsOnBase: false, kind, needsSetup: true } };
    return { bootFailure: { failsOnBase: true, kind, ...(boot?.alias ? { alias: boot.alias } : {}) } };
}

/** Every entry point of a member's PR the recipe does not boot: not tested, and never matched against another service. */
export function uncoveredByMemberNotBooted(entryPoints: string[], alias: string): Uncovered[] {
    return entryPoints.slice(0, 100).map((entryPoint) => ({ entryPoint: clip(entryPoint, 512), reason: 'blocker' as const, blocker: { kind: 'other_repo' as const, alias } }));
}

/** Every entry point of a Run whose base could not boot: not tested, because of that blocker. */
export function uncoveredByBoot(entryPoints: string[], blocker: { kind: BlockerKind; name?: string; cause?: BootBlockerCause } | undefined): Uncovered[] {
    return entryPoints.slice(0, 100).map((entryPoint) => ({ entryPoint: clip(entryPoint, 512), reason: 'blocker' as const, ...(validBlocker(blocker) ? { blocker: validBlocker(blocker)! } : {}) }));
}

const withSide = (side: 'base' | 'pr', o: Observed | undefined) => (o ? { [side]: o } : {});
