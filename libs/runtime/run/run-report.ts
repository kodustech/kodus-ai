import { z } from 'zod';

import { BLOCKER_KINDS, FINDING_INTENTS, FINDING_KINDS, MAX_RECIPE_CHANGED_PATHS, PARTLY_TESTED_CHECKS, RECIPE_CHANGED_PATH, RUN_TRIGGERS, SECURITY_VIOLATION_SIGNATURE, VERDICTS } from '@libs/runtime/contracts/enums';
import { KEPT_CHECK_SOURCE, KeptCheckOutcomeSchema, MAX_KEPT_CHECKS_PER_REPOSITORY } from '@libs/runtime/contracts/kept-check';
import { RepositoryAliasSchema } from '@libs/runtime/contracts/workspace';
import { BROWSER_STEP_KINDS } from '@libs/runtime/probe/probe.schema';
import { EXERCISED_LANGUAGES, EXERCISED_LINES_LIMITS, ExercisedResultSchema } from '@libs/runtime/protocol/messages';

import { LEAF_CHANGE_KINDS } from './leaf-changes';
import { RUN_STATES } from './run-state';

export { BLOCKER_KINDS, RUN_TRIGGERS };

// What the Runtime tells the product worker to say on the PR, as structured
// fields only (ADR-052). The product renders the comment, the replies and the
// check from these fields with its own wording and sanitizing; no prose of
// the agent or of the app reaches the PR through them.

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const label = z.string().min(1).max(512);
const at = z.iso.datetime();

/** The comment edited at each phase while the Run works (product screen 6). */
export const COMMENT_PHASES = ['booting', 'applying', 'testing', 'reporting'] as const;
export type CommentPhase = (typeof COMMENT_PHASES)[number];


/** Why a Run was skipped, when the product has to say it on the check (§3 table, screen 9). */
export const SKIP_REASONS = ['on_request_only', 'no_environment', 'bot_author', 'budget', 'rule_not_matched', 'stopped'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];


/** What one side answered to the probe: an HTTP status, an exit code or, for a browser probe, how many of its steps passed. Never the body or the page. */
export const ObservedSchema = z.strictObject({
    status: z.number().int().min(100).max(599).optional(),
    exitCode: z.number().int().min(-1).max(255).optional(),
    transport: z.enum(['ok', 'lost']).optional(),
    /** A browser probe (ADR-071): the steps that passed of those the runner played. */
    browser: z
        .strictObject({ passed: z.number().int().min(0).max(100), total: z.number().int().min(1).max(100) })
        .refine((b) => b.passed <= b.total, { message: 'passed is at most total' })
        .optional(),
});
export type Observed = z.infer<typeof ObservedSchema>;

/**
 * How a browser step parts main and the PR: it passes on one side only, it
 * fails on both but not the same way, or it passes on both and what it read
 * (an expectText or getAttribute value) differs. The value itself never
 * reaches the report.
 */
export const BROWSER_STEP_DIFFERENCES = ['fails_on_pr', 'fails_on_main', 'fails_differently', 'value_differs'] as const;
export type BrowserStepDifference = (typeof BROWSER_STEP_DIFFERENCES)[number];

/** The first browser step the gate's difference rests on: its position, its kind and what it acts on, from the probe's step. */
export const ReportBrowserStepSchema = z.strictObject({
    /** 0-based, as the runner numbers steps; the comment shows it 1-based like the Run page. */
    index: z.number().int().min(0).max(99),
    kind: z.enum(BROWSER_STEP_KINDS),
    /** The selector, route, key or screenshot name of the probe's step (exercised.ts browserStepTargetOf), redacted. Never page text. */
    target: z.string().min(1).max(128).optional(),
    outcome: z.enum(BROWSER_STEP_DIFFERENCES),
});
export type ReportBrowserStep = z.infer<typeof ReportBrowserStepSchema>;

export const INTENDED_BY = ['diff', 'test'] as const;

/** The verdict source of a probe the intent author wrote (ProbeVerdict.source). */
export const INTENT_PROBE_SOURCE = 'intent' as const;

/**
 * What the intent oracle did on a Run (docs/runtime/intent-oracle.md):
 * `checked`, the intent author read the PR's text (its probes, possibly none,
 * ran); `no_stated_intent`, the PR has no description and links no task, so
 * only the base comparison ran; `off`, the org turned it off; `unavailable`,
 * the author's turn failed.
 */
export const INTENT_CHECK_STATES = ['checked', 'no_stated_intent', 'off', 'unavailable'] as const;
export type IntentCheckState = (typeof INTENT_CHECK_STATES)[number];

const intentText = (max: number) => z.string().min(1).max(max);
const intentSource = z.string().regex(/^(description|task:\S{1,256})$/);

/**
 * The intent oracle on the PR: each answer that breaks an assertion quoted
 * from the PR's text (the sentence, the request, what it expected and
 * received, values cut and redacted), how many assertions held, and each
 * difference the PR describes. The quote is the PR author's text, validated
 * as a substring of its source; the product renders every field as untrusted.
 */
export const ReportIntentSchema = z.strictObject({
    state: z.enum(INTENT_CHECK_STATES),
    assertions: z.number().int().min(0).max(1_000),
    held: z.number().int().min(0).max(1_000),
    mismatches: z
        .array(
            z.strictObject({
                probeId: z.string().min(1).max(128),
                request: intentText(256),
                quote: intentText(500),
                source: intentSource,
                assertion: intentText(200),
                expected: intentText(200),
                received: intentText(200),
            }),
        )
        .max(20),
    described: z.array(z.strictObject({ probeId: z.string().min(1).max(128), entryPoint: label, quote: intentText(500), source: intentSource })).max(20),
});
export type ReportIntent = z.infer<typeof ReportIntentSchema>;

/**
 * What a finding on an object or array field is about, leaf by leaf
 * (gate/leaf-changes.ts): the leaves no passed assertion reads (at most 5, the
 * rest counted), how many leaves a passed assertion does read, and the paths
 * those assertions read (`mentions`), so the comment can say what the
 * description covers without quoting it. Values are cleaned and cut to 200
 * characters, a secret-looking key is `[redacted]`. ADR-052: the comment
 * carries these few leaves, not the Response tab.
 */
export const ReportLeafChangesSchema = z.strictObject({
    undescribed: z
        .array(
            z.strictObject({
                path: z.string().min(1).max(256),
                kind: z.enum(LEAF_CHANGE_KINDS),
                base: z.string().max(200).optional(),
                pr: z.string().max(200).optional(),
            }),
        )
        .min(1)
        .max(5),
    undescribedCount: z.number().int().min(1).max(10_000),
    describedCount: z.number().int().min(0).max(10_000),
    mentions: z.array(z.string().min(1).max(256)).max(5),
});
export type ReportLeafChanges = z.infer<typeof ReportLeafChangesSchema>;

/** One tested path: an entry point of the diff, the probe that exercised it and what each side did. */
export const ReportPathSchema = z.strictObject({
    entryPoint: label,
    probeId: z.string().min(1).max(128),
    /** What the probe sent, from its typed spec (`GET /api/health`), redacted. Never coverage: an `unmapped` path stays unmapped. */
    exercised: z.string().min(1).max(256).optional(),
    /** The changed file with no route of its own that this route reaches, by the agent's mapping (never coverage). */
    via: label.optional(),
    verdict: z.enum(VERDICTS),
    findingKind: z.enum(FINDING_KINDS).optional(),
    intent: z.enum(FINDING_INTENTS).optional(),
    /** What shows an intended change: the PR's diff spells it out (gate/intended-change.ts), or a test that existed on main expects it. */
    intendedBy: z.enum(INTENDED_BY).optional(),
    base: ObservedSchema.optional(),
    pr: ObservedSchema.optional(),
    differingFields: z.array(z.string().min(1).max(128)).max(5).optional(),
    /** A finding on an object or array field: the leaves that differ, split by what the description reads. */
    leafChanges: ReportLeafChangesSchema.optional(),
    /** A browser probe: the first step where main and the PR part, when the gate's difference rests on a step. */
    browserStep: ReportBrowserStepSchema.optional(),
    /** A browser probe: the largest share of a screenshot's pixels that changed on the PR against main's, in percent with one decimal. Absent under the gate's threshold. */
    pixelDiffPercent: z.number().min(0).max(100).optional(),
    /** Product id of the review suggestion this path reproduces; the product resolves its comment. */
    suggestionId: z.string().min(1).max(128).optional(),
    /** A kept check (docs/runtime/kept-checks.md) or an intent probe (docs/runtime/intent-oracle.md) played this path; absent: the Run's plan. */
    source: z.enum([KEPT_CHECK_SOURCE, INTENT_PROBE_SOURCE]).optional(),
    keptCheckId: z.uuid().optional(),
});
export type ReportPath = z.infer<typeof ReportPathSchema>;

/**
 * Why a boot blocker's paths were not tested, past its kind: the boot
 * outlived its wait (boot_timeout, kind resources, which is not a machine out
 * of resources), or it did because its builds ran with no cache, the cell
 * having evicted the environment's build state (build_state_evicted).
 */
export const BOOT_BLOCKER_CAUSES = ['boot_timeout', 'build_state_evicted'] as const;
export type BootBlockerCause = (typeof BOOT_BLOCKER_CAUSES)[number];

/** An entry point without sufficient evidence for success, and why. */
export const UncoveredSchema = z.strictObject({
    entryPoint: label,
    reason: z.enum(['no_probe', 'inconclusive', 'blocker', 'unverified', 'not_reached', 'pre_existing']),
    /** For a blocker: its kind and, for missing_env, the variable name (never a value). */
    blocker: z
        .strictObject({
            kind: z.enum(BLOCKER_KINDS),
            name: z
                .string()
                .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
                .optional(),
            /** For other_repo: the member of the environment the recipe does not boot, whose PR this Run tests. */
            alias: RepositoryAliasSchema.optional(),
            /** For a boot blocker: what its kind alone does not say (BOOT_BLOCKER_CAUSES). */
            cause: z.enum(BOOT_BLOCKER_CAUSES).optional(),
        })
        .optional(),
});
export type Uncovered = z.infer<typeof UncoveredSchema>;

const lineCount = z.number().int().min(0).max(EXERCISED_LINES_LIMITS.files * EXERCISED_LINES_LIMITS.linesPerFile);
/**
 * Which changed lines ran (exercised-lines.ts): the sum over the measured
 * files, the threshold the verdict used, and the cell's answer per file.
 * Absent on Runs before it, or when the worker did not ask.
 */
export const ReportExercisedSchema = z.strictObject({
    summary: z.strictObject({
        exercised: lineCount,
        changed: lineCount,
        threshold: z.number().min(0).max(1),
        language: z.enum(EXERCISED_LANGUAGES).optional(),
        measured: z.boolean(),
        /** Not measured because the changed files' coverage mapped back to no source. */
        reason: z.literal('no_source_map').optional(),
    }),
    files: ExercisedResultSchema.shape.files,
});
export type ReportExercised = z.infer<typeof ReportExercisedSchema>;

export const RuntimeRunReportSchema = z.strictObject({
    state: z.enum(RUN_STATES),
    verdictState: z.enum(['no_regressions', 'regression', 'partly_tested', 'could_not_boot', 'nothing_to_test']).optional(),
    headSha: sha,
    requestedAt: at,
    trigger: z.enum(RUN_TRIGGERS).optional(),
    /** Time from asking for the machines to both sides ready. */
    bootMs: z.number().int().min(0).max(86_400_000).optional(),
    paths: z.array(ReportPathSchema).max(100),
    uncovered: z.array(UncoveredSchema).max(100),
    blockedOutbound: z
        .array(z.strictObject({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65_535).optional() }))
        .max(20),
    dependencyChangeUntested: z.boolean().optional(),
    /** Probe and test commands the cells ran for this Run. */
    commands: z.number().int().min(0).max(100_000).optional(),
    machinesDestroyed: z.boolean().optional(),
    cellOwner: z.enum(['kodus', 'customer']).optional(),
    /** A canary crossed a boundary (ADR-043). */
    securityEvent: z.boolean().optional(),
    /** The cell saw one side's code exfiltrate (blocked security_violation): which side and the alert kind, never the host. */
    securityViolation: z.strictObject({ side: z.enum(['base', 'pr']), signature: z.string().regex(SECURITY_VIOLATION_SIGNATURE) }).optional(),
    skipReason: z.enum(SKIP_REASONS).optional(),
    /** could_not_boot: the base fails too, and the kind of the first blocker. */
    /** needsSetup: nothing failed to boot; the cell holds no prepared image of the environment, and the setup has to run again. */
    /** alias: the repository of a multi-repository environment that did not boot, when the blocker names one. */
    bootFailure: z.strictObject({ failsOnBase: z.boolean(), kind: z.enum(BLOCKER_KINDS), needsSetup: z.boolean().optional(), alias: RepositoryAliasSchema.optional() }).optional(),
    /**
     * A side whose builds ran with no cache because the cell had evicted the
     * environment's build state to free disk (when: evictedAt); a new setup
     * restores it. Set whether or not that side then booted.
     */
    coldBuild: z.strictObject({ side: z.enum(['base', 'pr']), cause: z.literal('build_state_evicted'), evictedAt: at }).optional(),
    /**
     * One line of a failed boot's output, of the side that decided the Run:
     * the line the blocker catalog matched, else the last error line, redacted
     * by the cell and the worker. The only log excerpt the report carries; the
     * product shows it in one inline code span, cut, never as a block (ADR-052).
     */
    bootError: z
        .strictObject({
            side: z.enum(['base', 'pr']),
            line: z
                .string()
                .min(1)
                .max(300)
                .regex(/^[^\r\n]*$/),
        })
        .optional(),
    /**
     * nothing_to_test: the changed files a parser judged to change nothing that runs (only comments,
     * layout or documentation), so the comment can name them. Repository paths, never their content.
     */
    noRuntimeEffect: z.array(z.string().min(1).max(512)).min(1).max(20).optional(),
    /** Recipe files the PR changes whose PR copy the Run never boots (S-19): the base's are used (ADR-012), so the PR's were not tested. */
    recipeChangedInPr: z.array(z.string().regex(RECIPE_CHANGED_PATH)).min(1).max(MAX_RECIPE_CHANGED_PATHS).optional(),
    /** The PR is in this member repository of a multi-repository environment: its recipeChangedInPr were not applied (only the primary's recipe boots). */
    recipeChangedInMember: RepositoryAliasSchema.optional(),
    exercised: ReportExercisedSchema.optional(),
    /**
     * The repository's kept checks on this Run: how many were played, how many
     * failed, and each one that could not run as kept (stale, skipped,
     * inconclusive), so the owner sees it. Absent: the Run carried none.
     */
    keptChecks: z
        .strictObject({
            played: z.number().int().min(0).max(MAX_KEPT_CHECKS_PER_REPOSITORY),
            failed: z.number().int().min(0).max(MAX_KEPT_CHECKS_PER_REPOSITORY),
            notRun: z.array(KeptCheckOutcomeSchema).max(MAX_KEPT_CHECKS_PER_REPOSITORY),
        })
        .optional(),
    /**
     * The org's choice, when the Run was asked, for a partly tested Run with
     * something left to decide (contracts/enums.ts PARTLY_TESTED_CHECKS).
     * Absent: action_required, the default. The product's check follows it.
     */
    partlyTestedCheck: z.enum(PARTLY_TESTED_CHECKS).optional(),
    /**
     * The PR's machine did not boot while the base did, and the egress proxy
     * denied it these hosts, the base was not (the hub's record of the
     * proxy's refusals, never the PR's output). The check needs action
     * whatever the org chose: approve the host, then run again.
     */
    prEgressDenied: z.strictObject({ hosts: z.array(z.string().min(1).max(253)).min(1).max(5) }).optional(),
    /** The intent oracle (docs/runtime/intent-oracle.md); absent on Runs before it, an external finding's or a simulation's. */
    intent: ReportIntentSchema.optional(),
});
export type RuntimeRunReport = z.infer<typeof RuntimeRunReportSchema>;

/** The comment while the Run works: one phase, with what is known so far. */
export const RuntimeRunProgressSchema = z.strictObject({
    phase: z.enum(COMMENT_PHASES),
    requestedAt: at,
    startedAt: at,
    trigger: z.enum(RUN_TRIGGERS).optional(),
    bootMs: z.number().int().min(0).max(86_400_000).optional(),
    applyMs: z.number().int().min(0).max(86_400_000).optional(),
    tested: z.strictObject({ done: z.number().int().min(0).max(1_000), total: z.number().int().min(0).max(1_000) }).optional(),
    regressions: z.number().int().min(0).max(1_000).optional(),
    /**
     * What the phases took on this environment's recent Runs (the worker's
     * measure), so the comment can say "usually ~8 min" while a long phase
     * runs. Absent: no earlier Run to go by.
     */
    estimates: z
        .strictObject({
            bootMs: z.number().int().min(0).max(86_400_000).optional(),
            applyMs: z.number().int().min(0).max(86_400_000).optional(),
        })
        .optional(),
});
export type RuntimeRunProgress = z.infer<typeof RuntimeRunProgressSchema>;
