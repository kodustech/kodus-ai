import { z } from 'zod';
import { BrowserStepSchema } from '@libs/runtime/probe/probe.schema';

/** Exploration is untrusted planner input, never a replay result or a verdict. */
export const BROWSER_EXPLORE_LIMITS = { actions: 10, timeoutMs: 30_000, runnerGraceMs: 10_000, snapshotChars: 8_000, candidates: 32, rounds: 2 } as const;

/** Refs belong to one ephemeral native session; only stable selectors survive it. */
export function isEphemeralBrowserRef(selector: string): boolean {
    return /^\s*@e[0-9]+\s*$/.test(selector);
}

export function browserSelectorProblem(selector: string): boolean {
    const value = selector.trim();
    // Engine prefixes/chaining are not CSS; the browser additionally parses
    // the selector before sending it to the native client.
    return isEphemeralBrowserRef(value) || value.includes('>>') || /^(?:internal:|[A-Za-z_][A-Za-z0-9_-]*\s*=|\/\/|\.\/\/|\(\s*\/\/)/i.test(value);
}

export const BrowserExploreStepSchema = z.union([
    BrowserStepSchema.options[0], BrowserStepSchema.options[1], BrowserStepSchema.options[2],
    BrowserStepSchema.options[3], BrowserStepSchema.options[4], BrowserStepSchema.options[5],
]);

export const BrowserExploreRequestSchema = z.strictObject({
    steps: z.array(BrowserExploreStepSchema).min(1).max(BROWSER_EXPLORE_LIMITS.actions),
    viewport: z.strictObject({ width: z.number().int().min(200).max(4096), height: z.number().int().min(200).max(4096) }),
    timeoutMs: z.number().int().min(1_000).max(BROWSER_EXPLORE_LIMITS.timeoutMs),
}).superRefine((r, ctx) => {
    // Mirrored by the Go decoder; refinements do not reach JSON Schema.
    if (!('goto' in r.steps[0])) ctx.addIssue({ code: 'custom', message: 'exploration starts with goto', path: ['steps'] });
    for (const [i, step] of r.steps.entries()) {
        const selector = 'click' in step ? step.click : 'fill' in step ? step.fill[0] : 'select' in step ? step.select[0] : 'waitFor' in step ? step.waitFor : undefined;
        if (selector !== undefined && browserSelectorProblem(selector)) ctx.addIssue({ code: 'custom', message: 'exploration requires a stable selector', path: ['steps', i] });
    }
});
export type BrowserExploreRequest = z.infer<typeof BrowserExploreRequestSchema>;

export const BrowserExploreResultSchema = z.strictObject({
    status: z.enum(['observed', 'blocked', 'timeout', 'unavailable', 'failed']),
    snapshot: z.string().max(BROWSER_EXPLORE_LIMITS.snapshotChars),
    candidates: z.array(z.strictObject({
        ref: z.string().regex(/^e[0-9]{1,6}$/),
        selector: z.string().min(1).max(1_024),
        role: z.string().max(64).optional(),
        name: z.string().max(256).optional(),
    })).max(BROWSER_EXPLORE_LIMITS.candidates),
    actionsCompleted: z.number().int().min(0).max(BROWSER_EXPLORE_LIMITS.actions),
    durationMs: z.number().int().min(0).max(120_000),
    cliCalls: z.number().int().min(0).max(200),
    truncated: z.boolean(),
}).superRefine((r, ctx) => {
    for (const [i, candidate] of r.candidates.entries()) {
        if (browserSelectorProblem(candidate.selector)) ctx.addIssue({ code: 'custom', message: 'candidate requires a stable selector', path: ['candidates', i, 'selector'] });
    }
});
export type BrowserExploreResult = z.infer<typeof BrowserExploreResultSchema>;
