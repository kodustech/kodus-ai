import { z } from 'zod';

import { BLOCKER_KINDS, FINDING_INTENTS, FINDING_KINDS, MAX_RECIPE_CHANGED_PATHS, RECIPE_CHANGED_PATH, RUN_TRIGGERS, SECURITY_VIOLATION_SIGNATURE, VERDICTS } from '@libs/runtime/contracts/enums';
import { BROWSER_STEP_KINDS } from '@libs/runtime/probe/probe.schema';

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
    base: ObservedSchema.optional(),
    pr: ObservedSchema.optional(),
    differingFields: z.array(z.string().min(1).max(128)).max(5).optional(),
    /** A browser probe: the first step where main and the PR part, when the gate's difference rests on a step. */
    browserStep: ReportBrowserStepSchema.optional(),
    /** A browser probe: the largest share of a screenshot's pixels that changed on the PR against main's, in percent with one decimal. Absent under the gate's threshold. */
    pixelDiffPercent: z.number().min(0).max(100).optional(),
    /** Product id of the review suggestion this path reproduces; the product resolves its comment. */
    suggestionId: z.string().min(1).max(128).optional(),
});
export type ReportPath = z.infer<typeof ReportPathSchema>;

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
        })
        .optional(),
});
export type Uncovered = z.infer<typeof UncoveredSchema>;

export const RuntimeRunReportSchema = z.strictObject({
    state: z.enum(RUN_STATES),
    verdictState: z.enum(['no_regressions', 'regression', 'partly_tested', 'could_not_boot']).optional(),
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
    bootFailure: z.strictObject({ failsOnBase: z.boolean(), kind: z.enum(BLOCKER_KINDS) }).optional(),
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
    /** Recipe files the PR changes whose PR copy the Run never boots (S-19): the base's are used (ADR-012), so the PR's were not tested. */
    recipeChangedInPr: z.array(z.string().regex(RECIPE_CHANGED_PATH)).min(1).max(MAX_RECIPE_CHANGED_PATHS).optional(),
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
