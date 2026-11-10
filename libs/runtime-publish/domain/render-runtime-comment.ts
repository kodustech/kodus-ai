import {
    checkFor,
    type CheckOutcome,
    type CommentPhase,
    type Observed,
    type ReportPath,
    type RuntimeRunProgress,
    type RuntimeRunReport,
    type SkipReason,
    type Uncovered,
} from '@libs/runtime/run';
import { VISUAL_CHANGE_ONLY_REASON } from '@libs/runtime/contracts/enums';

// The product's wording of a Kody Runtime result (product screens 6, 7 and 9).
// Built only from the structured fields of RuntimePublishRequested (ADR-052):
// every string that came from the Runtime (entry points, probe ids, hosts) is
// put in an inline code span, cut, and stripped of backticks and line
// breaks, so it cannot open a link, an image, a mention or a new block.

/** Where the comment points: pages of the Kodus dashboard, never the app. */
export interface RuntimeLinks {
    /** The Run page (live progress and evidence). */
    run?: string;
    /** The repository's Runtime settings (set up an environment, add a key). */
    settings?: string;
}

export function runtimeLinks(
    baseUrl: string | undefined,
    ids: { runId: string; repositoryId: string },
): RuntimeLinks {
    const base = baseUrl?.trim().replace(/\/+$/, '');
    if (!base || !/^https?:\/\/[^\s]+$/.test(base)) return {};
    return {
        run: `${base}/runtime/runs/${encodeURIComponent(ids.runId)}`,
        settings: `${base}/settings/code-review/${encodeURIComponent(ids.repositoryId)}/kody-runtime`,
    };
}

const MAX_CODE = 120;

/**
 * Hidden marker on every Runtime PR comment. A delivery that crashed after
 * creating the comment finds it by this marker instead of posting a second one.
 */
export const RUNTIME_COMMENT_MARKER = '<!-- kody-runtime:comment -->';

export function withCommentMarker(body: string): string {
    return body.includes(RUNTIME_COMMENT_MARKER)
        ? body
        : `${body}\n\n${RUNTIME_COMMENT_MARKER}`;
}

export function hasCommentMarker(body: unknown): boolean {
    return typeof body === 'string' && body.includes(RUNTIME_COMMENT_MARKER);
}

/** No approval path exists yet (no verified Git identity, no approve command): say so, promise nothing. */
const FORK_WAITING_LINE =
    'This pull request comes from a fork. A fork Run needs a maintainer approval, which Kodus cannot take yet, so it does not start.';

/** Untrusted text as an inline code span: one line, no backticks, cut. */
export function code(value: string): string {
    const flat = value
        .replace(/[`\r\n\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const cut =
        flat.length > MAX_CODE ? `${flat.slice(0, MAX_CODE - 1)}…` : flat;
    return `\`${cut || ' '}\``;
}

/**
 * A redacted log excerpt (the report's bootError line) as an inline code
 * span: the same sanitizing as `code`, cut in the middle so the error at the
 * end of the line survives. The app's output chooses this text: bidi and
 * zero-width characters go, and an HTML comment opener is broken so a line
 * can never carry the comment's own marker.
 */
export function codeExcerpt(value: string): string {
    const flat = value
        .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
        .replace(/<!--/g, '< !--')
        .replace(/[`\r\n\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (flat.length <= MAX_CODE) return `\`${flat || ' '}\``;
    const head = Math.ceil((MAX_CODE - 1) / 2);
    return `\`${flat.slice(0, head)}…${flat.slice(flat.length - (MAX_CODE - 1 - head))}\``;
}

/** A code span inside a table row: a pipe would end the cell. */
const cell = (value: string) => code(value).replace(/\|/g, '\\|');

const link = (text: string, url: string | undefined) =>
    url ? `[${text}](${url})` : text;

const plural = (n: number, one: string, many = `${one}s`) =>
    `${n} ${n === 1 ? one : many}`;

export function formatDuration(ms: number | undefined): string | undefined {
    if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
    const total = Math.round(ms / 1000);
    if (total < 60) return `${total}s`;
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
}

export function formatObserved(o: Observed | undefined): string {
    if (!o) return 'n/a';
    if (o.transport === 'lost') return 'no answer';
    if (o.status !== undefined) return String(o.status);
    if (o.exitCode !== undefined) return `exit ${o.exitCode}`;
    if (o.browser) return `${o.browser.passed}/${o.browser.total} steps`;
    return 'n/a';
}

const TRIGGER: Record<NonNullable<RuntimeRunReport['trigger']>, string> = {
    pull_request: 'this pull request was opened or updated',
    comment: 'someone commented `@kody runtime`',
    run_again: 'someone asked to run it again',
    simulate: 'a simulation on a past pull request',
    external_finding: 'an external finding requested independent verification',
};

const BLOCKER_LABEL: Record<
    NonNullable<RuntimeRunReport['bootFailure']>['kind'],
    string
> = {
    missing_env: 'a variable is missing',
    external_service: 'an external service is unreachable',
    toolchain: 'the toolchain does not match',
    native_dep: 'a native dependency is missing',
    resources: 'the machine ran out of resources',
    seed_data: 'the seed data did not load',
    other_repo: 'another repository is needed',
    platform: 'the platform failed',
    recipe_outdated: 'the recipe is outdated',
    unknown: 'the cause is not known yet',
    security_violation: 'the code under test tried to send a credential out of the machine',
};

/** What a security_violation signature (the cell's alert kind) means, in words; never the host or the value. */
const VIOLATION_LABEL: Record<string, string> = {
    credential_exfiltration: 'its test credential',
    bait_exfiltration: 'a decoy secret the cell planted',
};

const SKIP_LABEL: Record<SkipReason, string> = {
    on_request_only: 'On request only. Comment `@kody runtime` to run.',
    no_environment: 'No environment for this repository.',
    bot_author: 'Pull requests opened by bots do not run.',
    budget: "The organization's daily Runtime budget is used up.",
    rule_not_matched: 'No rule of this repository matched the pull request.',
    stopped: 'Kody Runtime is stopped for this organization.',
};

const UNCOVERED_LABEL: Record<RuntimeRunReport['uncovered'][number]['reason'], string> = {
    no_probe: 'no probe reached it',
    pre_existing: 'the same failure was observed on both versions',
    inconclusive: 'the comparison was inconclusive',
    blocker: 'the environment blocked it',
    unverified: 'claimed without a probe',
    not_reached: 'the Run stopped before it',
};

/**
 * S-19: a PR that changes the recipe (the files whose PR copy the Run never
 * boots: the workspace files, the setup's authored files) still runs with the
 * base's (ADR-012); true whether or not the Run booted at all. Template text;
 * the only Runtime values are the recipe paths.
 */
export function recipeChangedLine(report: Pick<RuntimeRunReport, 'recipeChangedInPr'>): string | undefined {
    const files = report.recipeChangedInPr;
    if (!files?.length) return undefined;
    return `This pull request changes the Runtime recipe (${files.map(code).join(', ')}). Kody boots every pull request with the recipe from the base branch, so the new recipe was not tested.`;
}

// ---------------------------------------------------------------------------
// Screen 6: the comment while the Run works
// ---------------------------------------------------------------------------

const PHASE_ORDER: CommentPhase[] = ['booting', 'applying', 'testing', 'reporting'];

/** Each phase in words: while it runs (and before), and once it is done. */
const PHASE_WORDING: Record<CommentPhase, { running: string; done: string }> = {
    // Both sides boot at once; the phase ends when main is up.
    booting: { running: 'Starting main and this pull request in isolated machines', done: 'Started main' },
    // Main is up; this pull request is still building and starting.
    applying: { running: 'Building and starting this pull request', done: 'Started this pull request' },
    testing: { running: 'Evaluating probes', done: 'Evaluated probes' },
    reporting: { running: 'Writing the report', done: 'Wrote the report' },
};

/** "14:05 UTC": the comment changes only at phase boundaries, so a relative time would go stale. */
export function formatUtcTime(iso: string): string | undefined {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return undefined;
    return `${new Date(t).toISOString().slice(11, 16)} UTC`;
}

/** "usually ~8 min" from what the phase took on this environment's recent Runs. */
export function usualDuration(ms: number | undefined): string | undefined {
    if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
    if (ms < 60_000) return 'usually under a minute';
    return `usually ~${Math.round(ms / 60_000)} min`;
}

/** What the current phase line adds: how far testing got, or how long the phase usually takes. */
function currentDetail(progress: RuntimeRunProgress): string | undefined {
    switch (progress.phase) {
        case 'booting':
            return usualDuration(progress.estimates?.bootMs);
        case 'applying':
            return usualDuration(progress.estimates?.applyMs);
        case 'testing':
            return testingDetail(progress, false);
        default:
            return undefined;
    }
}

function testingDetail(progress: RuntimeRunProgress, done: boolean): string | undefined {
    const tested = progress.tested;
    const regressions = progress.regressions ?? 0;
    return (
        [
            tested ? (done ? plural(tested.total, 'probe outcome') : `${tested.done} of ${tested.total} done`) : undefined,
            regressions ? `${plural(regressions, 'regression')}${done ? '' : ' so far'}` : undefined,
        ]
            .filter(Boolean)
            .join(' · ') || undefined
    );
}

/** What a finished phase line adds: the time it took, or what testing found. */
function doneDetail(phase: CommentPhase, progress: RuntimeRunProgress): string | undefined {
    switch (phase) {
        case 'booting':
            return formatDuration(progress.bootMs);
        case 'applying':
            return formatDuration(progress.applyMs);
        case 'testing':
            return testingDetail(progress, true);
        default:
            return undefined;
    }
}

export function renderProgressComment(
    progress: RuntimeRunProgress,
    links: RuntimeLinks,
): string {
    const current = PHASE_ORDER.indexOf(progress.phase);
    const line = (phase: CommentPhase, i: number) => {
        const words = PHASE_WORDING[phase];
        const [mark, text, detail] =
            i < current
                ? ['✓', words.done, doneDetail(phase, progress)]
                : i === current
                  ? ['◐', words.running, currentDetail(progress)]
                  : ['○', words.running, undefined];
        return `- ${mark} ${text}${detail ? ` · ${detail}` : ''}`;
    };
    const at = formatUtcTime(progress.startedAt);
    const started = at ? `Started at ${at}` : 'Started';
    return [
        '### Kody Runtime · running',
        '',
        progress.trigger ? `${started} because ${TRIGGER[progress.trigger]}.` : `${started}.`,
        '',
        ...PHASE_ORDER.map(line),
        '',
        `Kody edits this comment when a step ends, not in between. ${link('Watch live in Kodus', links.run)}`,
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Screens 7 and 9: the result, the check and the replies
// ---------------------------------------------------------------------------

const isRegression = (p: ReportPath) =>
    p.verdict === 'finding' && p.intent !== 'intended';
const isIntended = (p: ReportPath) =>
    p.verdict === 'finding' && p.intent === 'intended';

/** The check of the §3 table, computed by the product from the structured fields. */
export function checkOf(report: RuntimeRunReport): CheckOutcome {
    const findings = report.paths.filter(isRegression);
    const intended = report.paths.filter(isIntended);
    const forcedNeutral: string[] = [];
    if (report.blockedOutbound.length) {
        forcedNeutral.push(
            plural(report.blockedOutbound.length, 'blocked outbound request'),
        );
    }
    if (report.dependencyChangeUntested) {
        forcedNeutral.push('dependency change not behavior-tested');
    }
    const verdict =
        report.verdictState === 'could_not_boot'
            ? { verdictState: 'could_not_boot' as const }
            : report.verdictState
              ? {
                    verdictState: report.verdictState,
                    findings: findings as any[],
                    intendedFindings: intended as any[],
                    forcedNeutral,
                }
              : undefined;
    const reason =
        report.state === 'skipped' && report.skipReason
            ? 'Skipped'
            : undefined;
    return checkFor(report.state, verdict as any, reason, { securityViolation: !!report.securityViolation });
}

/** The coverage id of a probe that reached none of the diff's entry points (S-32). */
const OUTSIDE_DIFF = 'unmapped';
export const OUTSIDE_DIFF_MARKER = "outside this PR's paths";

/**
 * The path as the developer reads it. A probe outside the diff's entry points
 * shows its declared target (`exercised`, from its typed spec) with a marker; it still
 * covers nothing. `wrap` is `code` in prose and `cell` in the table.
 */
const shownPath = (p: ReportPath, wrap: (value: string) => string = code) => {
    // A route that reaches a changed file with no route of its own names that file: the mapping is Kody's.
    if (p.entryPoint !== OUTSIDE_DIFF) return p.via ? `${wrap(p.entryPoint)} (reaches ${wrap(p.via)})` : wrap(p.entryPoint);
    return p.exercised ? `${wrap(p.exercised)} (${OUTSIDE_DIFF_MARKER})` : `A path ${OUTSIDE_DIFF_MARKER}`;
};

/** A browser probe's path (ADR-071): its evidence on the Run page is screenshots and video, not a command. */
const isBrowserPath = (p: ReportPath) =>
    !!(p.base?.browser || p.pr?.browser || p.browserStep || p.pixelDiffPercent !== undefined);

const evidenceLink = (p: ReportPath, links: RuntimeLinks) =>
    link(isBrowserPath(p) ? 'Screenshots and video' : 'Command and output', links.run);

const BROWSER_STEP_DIFFERENCE: Record<NonNullable<ReportPath['browserStep']>['outcome'], string> = {
    fails_on_pr: 'fails on this PR',
    fails_on_main: 'fails on main',
    fails_differently: 'fails differently on main and on this PR',
    value_differs: 'differs',
};

/** "step 4 `expectText #orders` fails on this PR": the step 1-based like the Run page, its kind and target from the probe's step. */
const browserStepText = (s: NonNullable<ReportPath['browserStep']>) =>
    `step ${s.index + 1} ${code(s.target ? `${s.kind} ${s.target}` : s.kind)} ${BROWSER_STEP_DIFFERENCE[s.outcome]}`;

/** "1.3% of the screen changed"; one decimal at most, never below the gate's threshold (the report leaves it out). */
const pixelText = (percent: number) => `${Number(percent.toFixed(1))}% of the screen changed`;

/** A differing field the browser wording did not already say, as the reader knows it: `step 6 value`, `step 3 screenshot`. */
const browserFieldLabel = (field: string) => {
    const value = /^step\.(\d{1,2})\.value$/.exec(field);
    if (value) return `step ${Number(value[1]) + 1} value`;
    const pixels = /^pixels\.(\d{1,2})$/.exec(field);
    if (pixels) return `step ${Number(pixels[1]) + 1} screenshot`;
    return field === 'steps' ? 'step outcomes' : code(field);
};

/**
 * A browser probe's line: steps passed on each side, the first step the
 * difference rests on, how much of the screen changed, then any other field
 * the gate saw differ. Only the report's typed fields; never page text.
 */
const browserPathLine = (p: ReportPath, links: RuntimeLinks) => {
    const sides =
        p.base?.browser && p.pr?.browser
            ? `browser steps ${p.base.browser.passed}/${p.base.browser.total} passed on main, ${p.pr.browser.passed}/${p.pr.browser.total} on this PR`
            : `${formatObserved(p.base)} on main, ${formatObserved(p.pr)} on this PR`;
    const said = new Set<string>();
    // A step that fails also reads differently: its value is part of what the step line says.
    if (p.browserStep) said.add('steps').add(`step.${p.browserStep.index}.value`);
    if (p.pixelDiffPercent !== undefined) for (const f of p.differingFields ?? []) if (/^pixels\.\d+$/.test(f)) said.add(f);
    // The steps-passed counts already say the outcomes part when they differ.
    if (p.base?.browser && p.pr?.browser && p.base.browser.passed !== p.pr.browser.passed) said.add('steps');
    const rest = (p.differingFields ?? []).filter((f) => !said.has(f));
    const parts = [
        sides,
        ...(p.browserStep ? [browserStepText(p.browserStep)] : []),
        ...(p.pixelDiffPercent !== undefined ? [pixelText(p.pixelDiffPercent)] : []),
    ];
    const differs = rest.length ? `, ${parts.length > 1 ? 'also ' : ''}differs in ${rest.map(browserFieldLabel).join(', ')}` : '';
    return `${shownPath(p)}: ${parts.join('; ')}${differs}. ${evidenceLink(p, links)}`;
};

const pathLine = (p: ReportPath, links: RuntimeLinks) => {
    const base = formatObserved(p.base);
    const pr = formatObserved(p.pr);
    if (p.findingKind === 'pr_destabilizes_machine') {
        return `${shownPath(p)}: the machine fails on this PR (${pr}) and stays up on main. ${evidenceLink(p, links)}`;
    }
    if (isBrowserPath(p)) return browserPathLine(p, links);
    const differs =
        p.differingFields?.length && base === pr
            ? `, differs in ${p.differingFields.map(code).join(', ')}`
            : '';
    return `${shownPath(p)}: ${base} on main, ${pr} on this PR${differs}. ${link('Command and output', links.run)}`;
};

/** Existing typed fields suffice; no page text or agent claim becomes a question. */
const isVisualChange = (p: ReportPath): boolean =>
    p.verdict === 'inconclusive' && !p.findingKind && !p.browserStep &&
    !!p.differingFields?.length && p.differingFields.every((f) => /^pixels\.\d+$/.test(f)) &&
    !!p.base?.browser && !!p.pr?.browser;

const resultLabel = (p: ReportPath) => {
    if (isVisualChange(p)) return 'Visual change';
    if (isRegression(p)) return 'Regression';
    if (isIntended(p)) return 'Intended change';
    switch (p.verdict) {
        case 'not_reproduced':
            return 'Same on main and PR';
        case 'pre_existing':
            // Both sides answer the same, but not what Kody expected (kr-grafana #9: 200 and 200
            // where the probe expected a 503). "Fails on main too" read as a bug on main.
            return 'Same on main, not as expected';
        case 'inconclusive':
            return 'Inconclusive';
        case 'blocker':
            return 'Blocked';
        case 'unverified':
            return 'Not verified';
        default:
            return p.verdict;
    }
};

/** The failed boot's own line, as the developer reads it under the finding or the not-tested note. */
function bootErrorLine(report: RuntimeRunReport): string | undefined {
    if (!report.bootError) return undefined;
    const side = report.bootError.side === 'pr' ? 'this PR' : 'main';
    return `Boot output on ${side}: ${codeExcerpt(report.bootError.line)}`;
}

/** A PR that does not boot is a regression of its own: the boot error goes under it, not under "Could not test". */
const bootRegression = (report: RuntimeRunReport) =>
    report.bootError?.side === 'pr' && report.paths.some((p) => isRegression(p) && p.findingKind === 'pr_destabilizes_machine');

/** What could not be tested: blockers first (with what to add), then blocked hosts. */
function couldNotTest(report: RuntimeRunReport, links: RuntimeLinks): string[] {
    const lines: string[] = [];
    for (const u of report.uncovered.filter((x) => x.reason === 'blocker')) {
        const what = u.blocker?.name
            ? `missing ${code(u.blocker.name)}. ${link('Add it', links.settings)}`
            : u.blocker
              ? `${BLOCKER_LABEL[u.blocker.kind]}.`
              : 'the environment blocked it.';
        // The file, not the coverage id (`unmapped:pkg/x.go` reads as `pkg/x.go`).
        lines.push(`- ${entryPointLabel(u.entryPoint)}: ${what}`);
    }
    const boot = bootRegression(report) ? undefined : bootErrorLine(report);
    if (boot) lines.push(`- ${boot}`);
    if (report.blockedOutbound.length) {
        const hosts = report.blockedOutbound
            .slice(0, 5)
            .map((h) => code(h.port ? `${h.host}:${h.port}` : h.host))
            .join(', ');
        lines.push(
            `- ${plural(report.blockedOutbound.length, 'outbound request')} blocked by the network policy: ${hosts}.`,
        );
    }
    if (report.dependencyChangeUntested) {
        lines.push(
            '- The dependency change (lockfile, Dockerfile, compose or CI) was not behavior-tested.',
        );
    }
    return lines;
}

// ---------------------------------------------------------------------------
// Why a Run is partly tested, in words, from the structured fields only
// ---------------------------------------------------------------------------

/** Why an entry point could not be cleared. Blockers have their own section. */
type UncoveredGroup = 'unmapped_file' | 'diff_truncated' | 'no_probe' | 'inconclusive' | 'unverified' | 'not_reached' | 'pre_existing';

const UNMAPPED_PREFIX = 'unmapped:';
/** The entry point the extractor adds for a cut diff (entry-points/extract.ts). */
const DIFF_TRUNCATED_ENTRY_POINT = 'unmapped:diff-truncated';
/** Prefixes of the extractor's non-route ids (`kind:file`); a route id is `METHOD /path`. */
const FILE_ID_PREFIX = /^(unmapped|dependency_surface|job|cli):/;

function uncoveredGroupOf(u: Uncovered): UncoveredGroup | undefined {
    if (u.reason === 'blocker') return undefined;
    if (u.entryPoint === DIFF_TRUNCATED_ENTRY_POINT) return 'diff_truncated';
    if (u.reason === 'no_probe') return u.entryPoint.startsWith(UNMAPPED_PREFIX) ? 'unmapped_file' : 'no_probe';
    return u.reason;
}

/** An entry point as the reader knows it: a route as is, a file without the extractor's kind prefix. */
const entryPointLabel = (id: string) => code(id.replace(FILE_ID_PREFIX, ''));

const MAX_LISTED = 3;

/** "`a`, `b` and 2 more" */
function listOf(entryPoints: string[]): string {
    const shown = entryPoints.slice(0, MAX_LISTED).map(entryPointLabel);
    const rest = entryPoints.length - shown.length;
    if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
    return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown.join('');
}

/** One sentence per group: what happened and what the developer can do. Template text; entry points only in code spans. */
const GROUP_REASON: Record<UncoveredGroup, (list: string, many: boolean, links: RuntimeLinks) => string> = {
    pre_existing: (list) => `The same failure was observed on both versions for ${list}. These paths were exercised but could not be cleared. Investigate the existing failure before running again.`,
    unmapped_file: (list, many) =>
        `Kody could not map ${list} to a route, job or command it can call, so no probe reached ${many ? 'them' : 'it'}. Nothing to do if ${many ? 'they change' : 'it changes'} no behavior (a comment, a log line, a rename); otherwise check ${many ? 'them' : 'it'} by hand.`,
    diff_truncated: () => 'The diff was too large to test whole, so part of it was not tested. Split the pull request to test all of it.',
    no_probe: (list, many) =>
        `No request Kody sent reached ${list} in the running app, so ${many ? 'their' : 'its'} behavior on this pull request is unknown. ${many ? 'They' : 'It'} may need data, a login or a flag the environment does not have.`,
    inconclusive: (list) =>
        `Kody could not establish a reliable comparison for ${list}. Check the Run details before trying again.`,
    unverified: (list, many) => `${list} ${many ? 'were' : 'was'} reported as tested without a probe to back it, so ${many ? 'they do' : 'it does'} not count.`,
    not_reached: (list, many, links) =>
        `The Run stopped before it tested ${list}. ${link('Run again', links.run && `${links.run}#run-again`)} to test ${many ? 'them' : 'it'}.`,
};

const GROUP_ORDER: UncoveredGroup[] = ['unmapped_file', 'diff_truncated', 'no_probe', 'inconclusive', 'unverified', 'not_reached', 'pre_existing'];

function groupedUncovered(report: RuntimeRunReport): Map<UncoveredGroup, string[]> {
    const groups = new Map<UncoveredGroup, string[]>();
    for (const u of report.uncovered) {
        const group = uncoveredGroupOf(u);
        if (group) groups.set(group, [...(groups.get(group) ?? []), u.entryPoint]);
    }
    return groups;
}

/**
 * Why a partly tested Run has no verdict on everything, in plain words, with
 * what the developer can do. Built from the report's structured fields only
 * (§3 verdict table): blockers, blocked hosts and an untested dependency
 * change have their own "Could not test" section.
 */
export function partlyTestedReasons(report: RuntimeRunReport, links: RuntimeLinks): string[] {
    if (report.state !== 'partly_tested') return [];
    if (!report.paths.length && !report.uncovered.length) {
        return ['This pull request changes nothing Kody can call (no route, job or command), so there was nothing to test.'];
    }
    const groups = groupedUncovered(report);
    return GROUP_ORDER.filter((g) => groups.has(g)).map((g) => {
        const entryPoints = groups.get(g)!;
        return GROUP_REASON[g](listOf(entryPoints), entryPoints.length > 1, links);
    });
}

/** The same causes as counts, for the check summary, which never names an entry point. */
const GROUP_COUNT: Record<UncoveredGroup, (n: number) => string> = {
    pre_existing: (n) => `${n} with an existing failure on both versions`,
    unmapped_file: (n) => `${plural(n, 'file')} Kody cannot map to a route, job or command`,
    diff_truncated: () => 'the diff was too large to test whole',
    no_probe: (n) => `${n} not reached by any request`,
    inconclusive: (n) => `${n} inconclusive`,
    unverified: (n) => `${n} not verified`,
    not_reached: (n) => `${n} not reached before the Run stopped`,
};

function partlyTestedCheckLine(report: RuntimeRunReport): string {
    if (!report.paths.length && !report.uncovered.length) {
        return 'Nothing in this pull request that Kody can call: no route, job or command.';
    }
    const groups = groupedUncovered(report);
    const blocked = report.uncovered.filter((u) => u.reason === 'blocker').length;
    const causes = [
        ...GROUP_ORDER.filter((g) => groups.has(g)).map((g) => GROUP_COUNT[g](groups.get(g)!.length)),
        ...(blocked ? [`${blocked} blocked by the environment`] : []),
    ];
    const head = `${plural(report.uncovered.length, 'path')} without a verdict out of ${report.paths.length + report.uncovered.length}`;
    return causes.length ? `${head}: ${causes.join(', ')}.` : `${head}.`;
}

function footer(report: RuntimeRunReport, links: RuntimeLinks): string {
    const parts = [
        `Last run on \`${report.headSha.slice(0, 7)}\``,
        links.run ? link('Open in Kodus', links.run) : undefined,
        links.run ? link('Run again', `${links.run}#run-again`) : undefined,
        report.commands !== undefined
            ? plural(report.commands, 'command')
            : undefined,
        report.machinesDestroyed ? 'machine destroyed' : undefined,
        report.cellOwner === 'customer' ? 'ran on your own cell' : undefined,
    ].filter(Boolean);
    return parts.join(' · ');
}

/** One line under the title, per state (screen 9 wording; the review is never affected). */
function stateLine(report: RuntimeRunReport, links: RuntimeLinks): string | undefined {
    switch (report.state) {
        case 'could_not_boot': {
            const kind = report.bootFailure?.kind;
            const cause = kind ? `: ${BLOCKER_LABEL[kind]}` : '';
            return report.bootFailure?.failsOnBase === false
                ? `The environment did not boot${cause}. This is not a bug in the pull request. The review is not affected.`
                : `Fails on main too${cause}. This is not a bug in the pull request. The review is not affected.`;
        }
        case 'skipped': {
            const reason = report.skipReason
                ? SKIP_LABEL[report.skipReason]
                : 'This pull request was not run.';
            return report.skipReason === 'no_environment'
                ? `${reason} ${link('Set it up', links.settings)}`
                : reason;
        }
        case 'awaiting_approval':
            return FORK_WAITING_LINE;
        case 'timed_out':
            return `The Run took longer than the limit and was stopped. ${link('Run again', links.run && `${links.run}#run-again`)}`;
        case 'errored':
            return `Kody could not finish this Run. The review is not affected. ${link('Run again', links.run && `${links.run}#run-again`)}`;
        case 'cancelled':
        case 'superseded':
            return 'A newer push or the pull request closing stopped this Run.';
        default:
            return undefined;
    }
}

export function renderReportComment(
    report: RuntimeRunReport,
    links: RuntimeLinks,
): string {
    const check = checkOf(report);
    const regressions = report.paths.filter(isRegression);
    const intended = report.paths.filter(isIntended);
    const lines: string[] = [`### Kody Runtime · ${check.title}`, ''];

    const summary = [
        report.bootMs !== undefined
            ? `Booted in ${formatDuration(report.bootMs)}`
            : undefined,
        report.paths.length
            ? plural(report.paths.length, 'probe outcome')
            : undefined,
        report.paths.length ? plural(regressions.length, 'regression') : undefined,
    ].filter(Boolean);
    if (summary.length) lines.push(summary.join(' · '));
    if (report.trigger) lines.push(`Ran because: ${TRIGGER[report.trigger]}`);
    const extra = stateLine(report, links);
    if (extra) lines.push('', extra);
    const why = partlyTestedReasons(report, links);
    if (why.length) lines.push('', '**Why partly tested**', '', ...why.map((w) => `- ${w}`));
    const recipe = recipeChangedLine(report);
    if (recipe) lines.push('', `**Recipe changed**: ${recipe}`);
    if (report.securityViolation) {
        const what = VIOLATION_LABEL[report.securityViolation.signature] ?? 'a secret';
        const side = report.securityViolation.side === 'pr' ? "this pull request's code" : "the base branch's code";
        lines.push(
            '',
            `**Security violation**: in the isolated machine, ${side} sent ${what} to a host it was not issued for. The Run stopped and the machines are kept as evidence. Paths without a verdict were not verified.`,
        );
    } else if (report.securityEvent) {
        lines.push(
            '',
            '**Security event**: a decoy credential planted in the machine crossed a boundary, so the Run stopped. Paths without a verdict were not verified.',
        );
    }

    if (regressions.length || intended.length) {
        lines.push('', '**Findings**', '');
        const confirmed = regressions.filter((p) => p.suggestionId);
        if (confirmed.length) {
            lines.push(
                `- Confirmed ${plural(confirmed.length, 'review suggestion')}: ${confirmed.map((p) => shownPath(p)).join(', ')}.`,
            );
        }
        const boot = bootRegression(report) ? bootErrorLine(report) : undefined;
        for (const p of regressions) {
            lines.push(`- **Regression** ${pathLine(p, links)}`);
            if (boot && p.findingKind === 'pr_destabilizes_machine') lines.push(`  - ${boot}`);
        }
        for (const p of intended) {
            lines.push(
                `- **Intended change** ${pathLine(p, links)} A test that already existed on main expects it.`,
            );
        }
    }

    const blocked = couldNotTest(report, links);
    if (blocked.length) lines.push('', '**Could not test**', '', ...blocked);

    const visual = report.paths.filter(isVisualChange);
    if (visual.length) {
        lines.push('', '**Visual changes**', '', ...visual.map((p) =>
            `- **Visual change** ${pathLine(p, links)} ${VISUAL_CHANGE_ONLY_REASON}`,
        ));
    }

    if (report.paths.length) {
        lines.push(
            '',
            `<details><summary>Probe outcomes (${report.paths.length})</summary>`,
            '',
            '| Path | main | this PR | Result |',
            '|---|---|---|---|',
            ...report.paths.map(
                (p) =>
                    `| ${shownPath(p, cell)} | ${formatObserved(p.base)} | ${formatObserved(p.pr)} | ${resultLabel(p)} |`,
            ),
            '',
            '</details>',
        );
    }
    const notTested = report.uncovered.filter((u) => u.reason !== 'blocker');
    if (notTested.length) {
        lines.push(
            '',
            `<details><summary>Not tested (${notTested.length})</summary>`,
            '',
            ...notTested.map(
                (u) => `- ${entryPointLabel(u.entryPoint)}: ${UNCOVERED_LABEL[u.reason]}`,
            ),
            '',
            '</details>',
        );
    }

    lines.push('', '---', footer(report, links));
    return lines.join('\n');
}

/**
 * The short notice that replaces the progress when the report itself could
 * not be posted after every redrive (publication-redrive.ts): the verdict
 * title and a link to the Run, so the PR never stays at "Writing the report".
 */
export function renderUndeliveredReportComment(
    report: RuntimeRunReport,
    links: RuntimeLinks,
): string {
    const where = links.run ? link('Open in Kodus', links.run) : 'It is on the Run page in Kodus.';
    return [
        `### Kody Runtime · ${checkOf(report).title}`,
        '',
        `Kody finished this Run but could not post the full report here. ${where}`,
        '',
        '---',
        `Last run on \`${report.headSha.slice(0, 7)}\``,
    ].join('\n');
}

/**
 * The check the redrive sweeper closes when the result itself could not be
 * posted after every attempt: neutral, so a required check never stays open
 * on the PR, and never a verdict the PR did not get to see.
 */
export function renderUndeliveredCheckOutput(links: RuntimeLinks): {
    title: string;
    summary: string;
} {
    const where = links.run ? link('Open in Kodus', links.run) : 'It is on the Run page in Kodus.';
    return {
        title: 'Result not posted',
        summary: `Kody finished this Run but could not post its result on this pull request. ${where}`,
    };
}

/** The reply on a review suggestion the Runtime reproduced (screen 7). */
export function renderSuggestionReply(
    path: ReportPath,
    links: RuntimeLinks,
): string {
    const base = formatObserved(path.base);
    const pr = formatObserved(path.pr);
    return [
        `**Ran it: confirmed.** I sent ${shownPath(path)} to main and to this pull request: ${base} on main, ${pr} here.`,
        evidenceLink(path, links),
    ]
        .filter(Boolean)
        .join(' ');
}

/** Check title and summary (screen 9): counts and structured labels only (§4 publisher). */
export function renderCheckOutput(
    report: RuntimeRunReport,
    links: RuntimeLinks,
): CheckOutcome & { summary: string } {
    const check = checkOf(report);
    const regressions = report.paths.filter(isRegression).length;
    const blockers = report.uncovered.filter((u) => u.reason === 'blocker');
    const view = link('View run', links.run);
    let line: string;
    switch (report.state) {
        case 'no_regressions':
            line = `${plural(report.paths.length, 'probe outcome')}, same result on main and on this PR.`;
            break;
        case 'regression':
            line = `${plural(regressions, 'regression')} reproduced out of ${plural(report.paths.length, 'probe outcome')}.`;
            break;
        case 'halted':
            line = `${report.securityViolation ? 'Security violation' : 'Security event'}: the Run stopped. ${plural(regressions, 'regression')} reproduced out of ${plural(report.paths.length, 'probe outcome')}.`;
            break;
        case 'partly_tested': {
            const missing = blockers.find((b) => b.blocker?.name);
            line = missing
                ? `${plural(blockers.length, 'path')} skipped: missing ${code(missing.blocker!.name!)}. ${link('Add it', links.settings)}`
                : partlyTestedCheckLine(report);
            break;
        }
        default:
            line = stateLine(report, links) ?? check.title;
    }
    const summary = [
        line,
        recipeChangedLine(report),
        view === 'View run' ? undefined : view,
    ]
        .filter(Boolean)
        .join(' · ');
    return { ...check, summary };
}

type WireCheck = {
    status: 'queued' | 'in_progress' | 'completed';
    conclusion?: CheckOutcome['conclusion'];
};

/**
 * A check without a report: a phase before the verdict (queued, in progress,
 * or a fork waiting for a maintainer). Title and summary come from this
 * table only; the Runtime's own title and summary are never shown.
 */
export function renderBareCheckOutput(
    check: WireCheck,
    links: RuntimeLinks,
): { title: string; summary: string } {
    const title =
        check.status !== 'completed'
            ? check.status === 'queued'
                ? 'Queued'
                : 'Running'
            : check.conclusion === 'action_required'
              ? 'Waiting for a maintainer'
              : 'Finished';
    const line =
        check.status === 'completed' && check.conclusion === 'action_required'
            ? FORK_WAITING_LINE
            : 'Kody is testing this pull request.';
    const view = link('View run', links.run);
    return {
        title,
        summary: [line, view === 'View run' ? undefined : view]
            .filter(Boolean)
            .join(' · '),
    };
}
