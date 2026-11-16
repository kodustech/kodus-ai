import type { BlockerEvidence, BlockerFixView, BlockerInput, ClassifiedBlocker } from '../catalog';

// The shape of one rule of the blocker classifier (catalog.ts BLOCKER_RULES)
// and what several rules share: the lines they read, the evidence they keep
// and the fixes more than one card offers.

/** One log line, with the service that wrote it when it came from the bundle. */
export type Line = { service?: string; text: string };

/** What a rule reads: the blocker as the cell and the worker named it, and its lines. */
export interface RuleContext {
    input: BlockerInput;
    /** The bundle's log tails, oldest first per service, then the reason as one line. */
    lines: Line[];
}

/**
 * One rule: the card when it reads the blocker, null when it does not. The
 * classifier tries the rules in the order of BLOCKER_RULES and the first card
 * wins, so a rule never needs to know which rules come before it.
 */
export interface BlockerRule {
    /** Stable, for specs and logs: the signature or the cause it reads. */
    id: string;
    classify(ctx: RuleContext): ClassifiedBlocker | null;
}

/** A rule for one signature the cell or the hub sets: the card, built only when the signature is that one. */
export const bySignature = (signature: string, card: (ctx: RuleContext) => ClassifiedBlocker): BlockerRule => ({
    id: signature,
    classify: (ctx) => (ctx.input.signature === signature ? card(ctx) : null),
});

export const linesOf = (input: BlockerInput): Line[] => {
    const out: Line[] = [];
    for (const s of input.bundle?.services ?? []) for (const text of s.logTail) out.push({ service: s.name, text });
    out.push({ text: input.message });
    return out;
};

export const evidenceOf = (line: Line | undefined): BlockerEvidence => ({
    lines: line ? [line.text.slice(0, 500)] : [],
    ...(line?.service ? { service: line.service } : {}),
});

export const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
export const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const SERVICE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export const retry: BlockerFixView = {
    id: 'retry_setup',
    action: 'retry_setup',
    who: 'one_click',
    label: 'Run the setup again',
    detail: 'The failure was on the Kodus side, not in your repository. A new setup usually gets past it.',
};

export const useOwnCell: BlockerFixView = {
    id: 'use_own_cell',
    action: 'use_own_cell',
    who: 'settings',
    label: 'Run it on a cell of your own',
    detail: 'Register a cell of your organization under Cells: its machines serve only your environments, and no limit of the shared Kodus cells applies there.',
};

/** The environment's Machine size setting (contracts/machine-size.ts), and a self-hosted cell's own bounds. */
export const largerMachine = (detail: string): BlockerFixView => ({
    id: 'bump_machine',
    action: 'bump_machine',
    who: 'settings',
    label: 'Give the environment a larger machine',
    detail,
});

export const SELF_HOSTED_MEMORY =
    'On your own cell, a claim gets at most -gvisor-mem-max and -gvisor-cpus-max, and -gvisor-mem-limit when it asks no size: raise them on a machine that has the memory.';

export const fixRecipe = (detail: string): BlockerFixView => ({
    id: 'fix_recipe',
    action: 'fix_recipe',
    who: 'dev',
    label: 'Fix the recipe',
    detail,
});
