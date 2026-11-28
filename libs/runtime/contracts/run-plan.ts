import { z } from 'zod';
import { BROWSER_EXPLORE_LIMITS, BrowserExploreRequestSchema, BrowserExploreResultSchema, browserSelectorProblem } from './browser-exploration';

import type { EntryPoint } from '@libs/runtime/entry-points/extract';
import type { AgentClaim } from '@libs/runtime/gate/gate';
import { CompareFieldSchema, decidesVerdict, type Probe, ProbeSchema } from '@libs/runtime/probe/probe.schema';
import { type IntentAssertion, type ProbeAssertions, ProbeAssertionsSchema, type StatedIntent } from './probe-assertions';

// POST /internal/runtime/plan (ADR-069): the Run's test planner, an agent on
// the product's harness with the org's BYOK (ADR-057). It reads the repository
// at the Run's base sha through the Git integration and plans the probes; a
// shell command on the base machine is the one thing it cannot do there, so
// it asks the worker for it and the worker calls again with the output (a
// round). The checks below run on both sides: the tool returns what they
// refuse to the model, and the worker checks the plan it receives again.

export const RUN_PLAN_PATH = 'internal/runtime/plan';

export const RUN_PLAN_LIMITS = {
    /** Shell commands on the base machine, over all rounds of one plan. */
    maxExplore: 5,
    /** Rounds that ran commands; the round after the last one has no exec tool. */
    maxExecRounds: 2,
    /** Observed output of one command the model reads. */
    stdoutChars: 4_000,
    stderrChars: 1_000,
    /** What the agent keeps for itself across a round. */
    notesChars: 4_000,
    diffChars: 20_000,
    maxTests: 10,
    maxProbes: 30,
    /** Of each base answer the reconnaissance round shows, the start of the body. */
    reconBodyChars: 600,
} as const;

const UNMAPPED_PREFIX = 'unmapped:';
/** `GET /api/health`: the form of a route the agent may name for a file with no route of its own. */
const ROUTE = /^[A-Z]{3,7} \/\S{0,1023}$/;

export interface PlannedProbe {
    probe: Probe;
    /** Deterministic expectations, kept outside the cell's wire Probe. Absent on legacy plans. */
    assertions?: ProbeAssertions;
    entryPoint: string;
    /**
     * The changed file with no route of its own (an `unmapped` entry point) that
     * the agent says this route reaches. The agent's mapping, shown as such: the
     * route itself is still covered only by the observer's log (S-32).
     */
    via?: string;
    /** An intent probe (docs/runtime/intent-oracle.md): the sentence of the PR it comes from. Absent: the planner's probe. */
    intent?: StatedIntent;
    /** What that sentence says the PR answers, as closed assertions on the PR side (probe-assertions.ts IntentAssertionSchema). */
    intentAssertions?: IntentAssertion[];
}

/** A probe the intent author wrote from the PR's text: never from its code. */
export type IntentProbe = PlannedProbe & Required<Pick<PlannedProbe, 'intent' | 'intentAssertions'>>;

/**
 * A test of the repository the agent asks to run on base and PR. Its result is
 * internal evidence: it can only downgrade the intent of a finding (§4), never
 * create, clear or upgrade one.
 */
export interface PlannedTest {
    id: string;
    /** Repository-relative path of the test file the command runs. */
    path: string;
    command: string;
    /** The mapped entry point the test exercises. */
    entryPoint: string;
}

/**
 * A repository-relative test file path as a command may name it: plain
 * segments only (no glob, no space, no quote, no `.` or `..` segment, no
 * leading slash), so it is one shell word that names one file.
 */
const TEST_PATH = /^(?:\.\/)?[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)*$/;
const plainPath = (p: string) => TEST_PATH.test(p) && !p.replace(/^\.\//, '').split('/').some((s) => s === '.' || s === '..');

/** The test runners a planned test may call, each as the exact words that start the command. */
const JS_RUNNERS = ['jest', 'vitest run', 'vitest', 'mocha', 'playwright test'];
const RUNNER_PREFIXES: ReadonlyArray<{ words: string; flags: ReadonlySet<string>; valued: ReadonlySet<string>; go?: true }> = [
    ...['', 'npx ', 'pnpm exec ', 'yarn ', 'bunx '].flatMap((pre) =>
        JS_RUNNERS.map((r) => ({ words: `${pre}${r}`, flags: new Set(['--runInBand', '-i', '--ci', '--silent', '--verbose', '--run']), valued: new Set(['-t', '--testNamePattern', '--grep', '-g']) })),
    ),
    { words: 'node --test', flags: new Set<string>(), valued: new Set<string>() },
    { words: 'bun test', flags: new Set<string>(), valued: new Set(['-t']) },
    ...['pytest', 'python -m pytest', 'python3 -m pytest'].map((words) => ({ words, flags: new Set(['-q', '-x', '-v', '-vv']), valued: new Set(['-k']) })),
    ...['rspec', 'bundle exec rspec'].map((words) => ({ words, flags: new Set<string>(), valued: new Set<string>() })),
    { words: 'go test', flags: new Set(['-v', '-count=1', '-race']), valued: new Set(['-run']), go: true },
];
/** A value a runner flag such as `-t` or `-run` takes: one plain word, never a path or a shell character. */
const FLAG_VALUE = /^[A-Za-z0-9_^.:-]{1,128}$/;

/**
 * Whether a planned test's command runs exactly its file with a known runner
 * and nothing else (s1-security-crosscut S1-02). The planner reads the PR's
 * diff, so the command is untrusted text that runs in both machines: one shell
 * word per token from a closed set (no `;`, `|`, `$`, quote or redirect), the
 * runner first, the file (for Go, the package directory that holds it)
 * exactly once, and only flags that select or quiet tests. A flag naming a
 * config, a package script (`npm test`, which the repository's
 * package.json decides) and a command that only names the file (`true
 * test/login.spec.ts`) are refused.
 */
export function plannedTestCommandProblem(t: { path: string; command: string }): string | undefined {
    if (!plainPath(t.path)) return 'the test path must be one plain repository-relative file path';
    const command = t.command.trim();
    if (!/^[A-Za-z0-9 ._@+/=^:-]+$/.test(command) || /\s{2,}/.test(command)) return 'the test command must be plain words, with no shell syntax';
    const runner = RUNNER_PREFIXES.filter((r) => command === r.words || command.startsWith(`${r.words} `)).sort((a, b) => b.words.length - a.words.length)[0];
    if (!runner) return 'the test command must start with a known test runner (jest, vitest, mocha, playwright test, node --test, bun test, pytest, rspec, go test)';
    const file = t.path.replace(/^\.\//, '');
    const target = runner.go ? `./${file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.'}` : file;
    if (runner.go && !/_test\.go$/.test(file)) return 'a go test must name a _test.go file';
    const words = command.slice(runner.words.length).split(' ').filter(Boolean);
    let named = 0;
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (w.replace(/^\.\//, '') === target.replace(/^\.\//, '') || (runner.go && w === target)) {
            named++;
            continue;
        }
        if (runner.flags.has(w)) continue;
        if (runner.valued.has(w) && i + 1 < words.length && FLAG_VALUE.test(words[i + 1]) && !words[i + 1].includes('/')) {
            i++;
            continue;
        }
        return `the test command may only add flags that select or quiet tests, not ${w.slice(0, 64)}`;
    }
    return named === 1 ? undefined : 'the test command must run the file it names, once';
}

export const PlannedTestSchema = z
    .strictObject({
        id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
        path: z
            .string()
            .min(1)
            .max(1_024)
            .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), { message: 'test path must be repository-relative' }),
        command: z.string().min(1).max(4_096),
        entryPoint: z.string().min(1).max(512),
    })
    .superRefine((t, ctx) => {
        const problem = plannedTestCommandProblem(t);
        if (problem) ctx.addIssue({ code: 'custom', message: problem });
    });

/** The files of the diff's `unmapped` entry points (not the truncation marker). */
export function unmappedFilesOf(entryPoints: Pick<EntryPoint, 'id' | 'kind'>[]): string[] {
    return [
        ...new Set(
            entryPoints
                .filter((e) => e.kind === 'unmapped' && e.id.startsWith(UNMAPPED_PREFIX) && e.id !== `${UNMAPPED_PREFIX}diff-truncated`)
                .map((e) => e.id.slice(UNMAPPED_PREFIX.length)),
        ),
    ];
}

/** What the agent says it cannot prove: strings, or {entryPoint|file, reason} items read as "x: reason". */
export function cannotProveOf(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((c: any) => {
            if (typeof c === 'string') return c;
            const what = typeof c?.entryPoint === 'string' ? c.entryPoint : typeof c?.file === 'string' ? c.file : undefined;
            const why = typeof c?.reason === 'string' ? c.reason : typeof c?.why === 'string' ? c.why : undefined;
            return what && why ? `${what}: ${why}` : undefined;
        })
        .filter((c): c is string => !!c)
        .map((c) => c.slice(0, 500))
        .slice(0, 50);
}

export interface PlanScope {
    /** Ids of the diff's entry points the extractor mapped (routes, jobs, CLIs). */
    mapped: string[];
    /** Changed files with no route of their own. */
    unmappedFiles: string[];
}

export interface CheckedPlan {
    probes: PlannedProbe[];
    tests: PlannedTest[];
    claims: AgentClaim[];
    cannotProve: string[];
    /** Items the checks refused, with why (schema messages, no repository text). */
    rejected: { reason: string }[];
    /** Probes kept but labelled `unmapped`: their entry point is neither in the diff nor a route with a known `via`. */
    unlabelled: string[];
    /** Entry points and unmapped files with no probe and no `cannotProve` line. */
    missing: string[];
}

/** Whether a `cannotProve` line names this entry point or file ("<it>: why"). */
const names = (line: string, what: string) => line === what || line.startsWith(`${what}:`) || line.startsWith(`${what} `);

/**
 * The plan the agent submitted, checked: each probe against ProbeSchema and
 * the rule that a shell probe cannot decide; each test against
 * PlannedTestSchema, a mapped entry point and a unique id. A probe whose entry
 * point is not one of the diff stays, labelled `unmapped` (coverage is the
 * observer's log, S-32), and is reported in `unlabelled`.
 */
export function checkPlanSubmission(raw: unknown, scope: PlanScope): CheckedPlan {
    const out: any = raw && typeof raw === 'object' ? raw : {};
    const probes: PlannedProbe[] = [];
    const rejected: { reason: string }[] = [];
    const unlabelled: string[] = [];
    const ids = new Set<string>();
    const items: any[] = Array.isArray(out.probes) ? out.probes : [];
    if (items.length > RUN_PLAN_LIMITS.maxProbes) rejected.push({ reason: `probes: only the first ${RUN_PLAN_LIMITS.maxProbes} are kept` });
    for (const item of items.slice(0, RUN_PLAN_LIMITS.maxProbes)) {
        // A probe written flat in the item ({entryPoint, id, spec, ...}) is the same probe.
        const { entryPoint: _ep, via: _via, assertions: rawAssertions, ...flat } = item ?? {};
        const rawProbe = { ...(item?.probe ?? flat) };
        // `expected` is the agent's prediction in words; a structured one is kept as its JSON text.
        if (rawProbe.expected !== undefined && typeof rawProbe.expected !== 'string') rawProbe.expected = JSON.stringify(rawProbe.expected);
        // An HTTP probe compares its floor whatever it lists (status, the JSON body, an HTML page's text and markup:
        // gate/probe-fields.ts): a word outside the closed list ("body", "html") adds nothing, and refusing the probe
        // for it cost demo-remix#2 its only probe. Other kinds keep the refusal.
        if (rawProbe.spec?.kind === 'http' && Array.isArray(rawProbe.compare)) {
            const known = rawProbe.compare.filter((c: unknown) => CompareFieldSchema.safeParse(c).success);
            rawProbe.compare = known.length ? known : ['status'];
        }
        const parsed = ProbeSchema.safeParse({ ...rawProbe, origin: 'agent' });
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            rejected.push({ reason: issue ? `${issue.path.join('.') || 'probe'}: ${issue.message}` : 'invalid probe' });
            continue;
        }
        const asserted = ProbeAssertionsSchema.optional().safeParse(rawAssertions);
        if (!asserted.success || (asserted.data && parsed.data.spec.kind !== 'http')) {
            rejected.push({ reason: `probe ${parsed.data.id}: assertions must be closed HTTP expectations with status 100–599 and optional nonempty bodyIncludes (at most 2000 characters)` });
            continue;
        }
        const spec = parsed.data.spec;
        if (spec.kind === 'http' && spec.body) {
            const types = Object.entries(spec.headers ?? {}).filter(([key]) => key.toLowerCase() === 'content-type');
            if (types.length !== 1 || !types[0][1].trim()) {
                rejected.push({ reason: `probe ${parsed.data.id}: a nonempty HTTP body requires one explicit nonempty Content-Type header` });
                continue;
            }
        }
        if (!decidesVerdict(parsed.data.spec)) {
            rejected.push({ reason: `probe ${parsed.data.id}: shell is internal evidence and cannot decide` });
            continue;
        }
        if (ids.has(parsed.data.id)) {
            rejected.push({ reason: `probe ${parsed.data.id}: duplicate id` });
            continue;
        }
        const browserProblem = browserProbeProblem(parsed.data);
        if (browserProblem) {
            rejected.push({ reason: `probe ${parsed.data.id}: ${browserProblem}` });
            continue;
        }
        ids.add(parsed.data.id);
        const checkedProbe = { probe: parsed.data, ...(asserted.data ? { assertions: asserted.data } : {}) };
        if (scope.mapped.includes(item.entryPoint)) {
            probes.push({ ...checkedProbe, entryPoint: item.entryPoint });
        } else if (typeof item.via === 'string' && scope.unmappedFiles.includes(item.via) && typeof item.entryPoint === 'string' && ROUTE.test(item.entryPoint)) {
            probes.push({ ...checkedProbe, entryPoint: item.entryPoint, via: item.via });
        } else {
            probes.push({ ...checkedProbe, entryPoint: 'unmapped' });
            unlabelled.push(parsed.data.id);
        }
    }
    const tests: PlannedTest[] = [];
    for (const item of (Array.isArray(out.tests) ? out.tests : []).slice(0, RUN_PLAN_LIMITS.maxTests)) {
        const parsed = PlannedTestSchema.safeParse(item);
        if (!parsed.success) {
            rejected.push({ reason: `test: ${parsed.error.issues[0]?.message ?? 'invalid test'}` });
            continue;
        }
        if (!scope.mapped.includes(parsed.data.entryPoint)) {
            rejected.push({ reason: `test ${parsed.data.id}: entry point is not one of the diff` });
            continue;
        }
        if (tests.some((t) => t.id === parsed.data.id)) {
            rejected.push({ reason: `test ${parsed.data.id}: duplicate id` });
            continue;
        }
        tests.push(parsed.data);
    }
    const claims: AgentClaim[] = (Array.isArray(out.claims) ? out.claims : [])
        .filter((c: any) => typeof c?.text === 'string')
        .slice(0, 50)
        .map((c: any) => ({ text: c.text.slice(0, 2_000), probeId: typeof c.probeId === 'string' ? c.probeId : undefined }));
    const cannotProve = cannotProveOf(out.cannotProve);
    const missing = [
        ...scope.mapped.filter((e) => !probes.some((p) => p.entryPoint === e) && !cannotProve.some((c) => names(c, e))),
        ...scope.unmappedFiles.filter((f) => !probes.some((p) => p.via === f) && !cannotProve.some((c) => names(c, f) || names(c, `${UNMAPPED_PREFIX}${f}`))),
    ];
    return { probes, tests, claims, cannotProve, rejected, unlabelled, missing };
}

/**
 * A browser probe that cannot show anything (ADR-071): it must load a page
 * first and look at it (a screenshot, or a text or attribute it reads);
 * steps that only click compare nothing but pass or fail.
 */
function browserProbeProblem(p: Probe): string | undefined {
    if (p.spec.kind !== 'browser') return undefined;
    const steps = p.spec.steps;
    for (const step of steps) {
        const selector = 'click' in step ? step.click : 'fill' in step ? step.fill[0] : 'select' in step ? step.select[0] : 'waitFor' in step ? step.waitFor : 'expectText' in step ? step.expectText[0] : 'getAttribute' in step ? step.getAttribute[0] : undefined;
        if (selector !== undefined && browserSelectorProblem(selector)) return 'browser replay requires stable CSS selectors, not session refs or selector engines';
    }
    if (!('goto' in steps[0])) return 'a browser probe starts with goto';
    if (!steps.some((s) => 'screenshot' in s || 'expectText' in s || 'getAttribute' in s)) return 'a browser probe looks at the page: add a screenshot, expectText or getAttribute step';
    return undefined;
}

/** What the agent must fix before its plan is accepted; empty when it may stand. */
export function planProblems(plan: CheckedPlan): string[] {
    return [
        ...plan.rejected.map((r) => r.reason),
        ...plan.unlabelled.map(
            (id) => `probe ${id}: its entryPoint is not one of the diff; name one of entryPoints, or a route ("GET /path") with "via" set to one of unmappedFiles`,
        ),
        ...plan.missing.map((m) => `${m}: no probe tests it and it is not in cannotProve`),
    ];
}

const Usage = z.object({ measurement: z.enum(['partial', 'unknown']).optional(), inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) });

export const PlanObservationSchema = z.strictObject({
    command: z.string().min(1).max(4_096),
    exitCode: z.number().int(),
    stdout: z.string().max(RUN_PLAN_LIMITS.stdoutChars),
    stderr: z.string().max(RUN_PLAN_LIMITS.stderrChars).optional(),
});
export type PlanObservation = z.infer<typeof PlanObservationSchema>;

/**
 * What base answered to one probe of a submitted plan, sent once before the
 * replay (the reconnaissance round): status, media type and the start of the
 * body, cleaned, plus the doubts Kody read from them. Never a status to copy
 * into the plan: the worker keeps the status first predicted for each id.
 */
export const ReconAnswerSchema = z.strictObject({
    probeId: z.string().min(1).max(128),
    request: z.string().min(1).max(1_100),
    status: z.number().int().optional(),
    contentType: z.string().max(200).optional(),
    bodyStart: z.string().max(RUN_PLAN_LIMITS.reconBodyChars).optional(),
    /** Two GETs answered bodies that compare different (an HTML page's text or markup, any other body's digest): the compare cannot show a change. */
    varies: z.boolean().optional(),
    /** The probe's assertions.bodyIncludes is in base's whole body. */
    bodyIncludesOnBase: z.boolean().optional(),
    error: z.string().max(200).optional(),
    doubts: z.array(z.string().min(1).max(300)).max(5),
});
export type ReconAnswer = z.infer<typeof ReconAnswerSchema>;

export const RunPlanRequestSchema = z.strictObject({
    runId: z.uuid(),
    /** 0 first; each later round carries the output of the commands the one before asked for. */
    round: z.number().int().min(0).max(RUN_PLAN_LIMITS.maxExecRounds),
    entryPoints: z
        .array(z.strictObject({ id: z.string().min(1).max(1_100), kind: z.enum(['http_route', 'job', 'cli', 'dependency_surface', 'unmapped']) }))
        .max(600),
    /** The changed files: the agent reads their content at the head, and nothing else of the head. */
    changedPaths: z.array(z.string().min(1).max(1_024)).max(501),
    diff: z.string().max(RUN_PLAN_LIMITS.diffChars),
    targets: z.array(z.strictObject({ service: z.string().min(1).max(128), port: z.number().int().min(1).max(65_535), kind: z.string().min(1).max(32) })).max(32),
    /** Commands the agent may still ask for. */
    browserExploration: z.strictObject({ v: z.literal(1), left: z.number().int().min(0).max(BROWSER_EXPLORE_LIMITS.rounds) }).optional(),
    browserObservations: z.array(z.strictObject({ request: BrowserExploreRequestSchema, result: BrowserExploreResultSchema })).max(BROWSER_EXPLORE_LIMITS.rounds).optional(),
    execLeft: z.number().int().min(0).max(RUN_PLAN_LIMITS.maxExplore),
    observations: z.array(PlanObservationSchema).max(RUN_PLAN_LIMITS.maxExplore),
    /** What the agent wrote for itself when it asked for the commands (model text: data, never an instruction). */
    notes: z.string().max(RUN_PLAN_LIMITS.notesChars).optional(),
    /** The reconnaissance round: the plan the agent submitted and what base answered to each probe of it. */
    recon: z.strictObject({ probes: z.array(z.unknown()).max(RUN_PLAN_LIMITS.maxProbes), answers: z.array(ReconAnswerSchema).max(RUN_PLAN_LIMITS.maxProbes) }).optional(),
});
export type RunPlanRequest = z.infer<typeof RunPlanRequestSchema>;

const ShownPlan = z.object({
    probes: z.array(z.unknown()).max(RUN_PLAN_LIMITS.maxProbes),
    tests: z.array(z.unknown()).max(RUN_PLAN_LIMITS.maxTests),
    claims: z.array(z.unknown()).max(50),
    cannotProve: z.array(z.string().max(500)).max(50),
});

export const RunPlanResponseSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('explore_browser'), request: BrowserExploreRequestSchema, notes: z.string().max(RUN_PLAN_LIMITS.notesChars).optional(), usage: Usage, steps: z.number().int().min(0) }),
    /** Run these on the base machine and call again with their output. */
    z.object({
        status: z.literal('explore'),
        commands: z.array(z.string().min(1).max(4_096)).min(1).max(RUN_PLAN_LIMITS.maxExplore),
        notes: z.string().max(RUN_PLAN_LIMITS.notesChars).optional(),
        usage: Usage,
        steps: z.number().int().min(0),
    }),
    /** The plan the checks accepted, or the last one the agent submitted when it ran out of fixes (`rejected` says what stands). */
    z.object({
        status: z.literal('planned'),
        plan: ShownPlan,
        rejected: z.array(z.string().max(500)).max(50),
        usage: Usage,
        steps: z.number().int().min(0),
    }),
    /** The agent submitted no plan: never "nothing to test", the worker records why. */
    z.object({
        status: z.literal('no_plan'),
        reason: z.string().min(1).max(500),
        rejected: z.array(z.string().max(500)).max(50),
        usage: Usage,
        steps: z.number().int().min(0),
    }),
]);
export type RunPlanResponse = z.infer<typeof RunPlanResponseSchema>;
