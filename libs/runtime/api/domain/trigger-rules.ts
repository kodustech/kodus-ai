// When the Runtime runs on a repository (product screen 2: Off / On request /
// Rules). Stored by the API in `runtime_repository_settings`; the PR trigger
// (PR 2) asks `decideRun` before it enqueues a Run. Pure and cheap: rules are
// checked first and cost nothing to evaluate.

export const RUNTIME_MODES = ['off', 'on_request', 'rules'] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export const RULE_FIELDS = ['changed_paths', 'label', 'files_changed'] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export type RuleCondition =
    | { field: 'changed_paths'; matches: string }
    | { field: 'label'; includes: string }
    | { field: 'files_changed'; moreThan: number };

/** Every condition must hold (AND); any rule that holds runs the PR (OR). */
export interface TriggerRule {
    conditions: RuleCondition[];
}

export const MAX_RULES = 20;
export const MAX_CONDITIONS = 5;

type GlobToken = { kind: 'lit'; c: string } | { kind: 'one' } | { kind: 'star' } | { kind: 'any' } | { kind: 'dirs' };

/**
 * Glob as the product uses it: `**` crosses folders, `*` does not, `?` is one
 * character, `**\/` is zero or more whole folders. Matched by walking the set
 * of live positions one character at a time, never by backtracking: the cost
 * is path length × glob length, whatever the glob. (A regular expression of
 * `*a*a*a*…b` took seconds on a 60-character path, and the path is the PR
 * author's to choose.)
 */
export function compileGlob(glob: string): { test(path: string): boolean } {
    const tokens: GlobToken[] = [];
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                i++;
                if (glob[i + 1] === '/') {
                    i++;
                    tokens.push({ kind: 'dirs' });
                } else {
                    tokens.push({ kind: 'any' });
                }
            } else if (tokens[tokens.length - 1]?.kind !== 'star') {
                tokens.push({ kind: 'star' });
            }
        } else if (c === '?') {
            tokens.push({ kind: 'one' });
        } else {
            tokens.push({ kind: 'lit', c });
        }
    }
    const n = tokens.length;
    // State 2p: before token p. State 2p+1: inside a `**\/` at p (past `.*`, waiting for the `/`).
    const close = (live: Uint8Array) => {
        for (let p = 0; p < n; p++) {
            if (!live[2 * p]) continue;
            const k = tokens[p].kind;
            if (k === 'star' || k === 'any' || k === 'dirs') live[2 * (p + 1)] = 1;
            if (k === 'dirs') live[2 * p + 1] = 1;
        }
    };
    return {
        test(path: string) {
            let live = new Uint8Array(2 * (n + 1));
            live[0] = 1;
            close(live);
            for (const ch of path) {
                const next = new Uint8Array(2 * (n + 1));
                const set = (state: number) => {
                    next[state] = 1;
                };
                for (let p = 0; p < n; p++) {
                    const t = tokens[p];
                    if (live[2 * p]) {
                        if ((t.kind === 'lit' && t.c === ch) || (t.kind === 'one' && ch !== '/')) set(2 * (p + 1));
                        if ((t.kind === 'star' && ch !== '/') || t.kind === 'any') set(2 * p);
                    }
                    // Inside `**\/` (entered by the closure): any character stays, a `/` may also leave.
                    if (live[2 * p + 1]) {
                        set(2 * p + 1);
                        if (ch === '/') set(2 * (p + 1));
                    }
                }
                if (!next.includes(1)) return false;
                close(next);
                live = next;
            }
            return live[2 * n] === 1;
        },
    };
}

/** Validates rules from the dashboard; returns the error to show, or the normalized rules. */
export function parseTriggerRules(value: unknown): { ok: true; rules: TriggerRule[] } | { ok: false; error: string } {
    if (!Array.isArray(value)) return { ok: false, error: 'rules must be an array' };
    if (value.length > MAX_RULES) return { ok: false, error: `at most ${MAX_RULES} rules` };
    const rules: TriggerRule[] = [];
    for (const raw of value) {
        const conditions = (raw as { conditions?: unknown })?.conditions;
        if (!Array.isArray(conditions) || conditions.length === 0 || conditions.length > MAX_CONDITIONS) {
            return { ok: false, error: `each rule needs 1 to ${MAX_CONDITIONS} conditions` };
        }
        const parsed: RuleCondition[] = [];
        for (const c of conditions as Array<Record<string, unknown>>) {
            if (c?.field === 'changed_paths' && typeof c.matches === 'string' && c.matches.trim() && c.matches.length <= 256) {
                parsed.push({ field: 'changed_paths', matches: c.matches.trim() });
            } else if (c?.field === 'label' && typeof c.includes === 'string' && c.includes.trim() && c.includes.length <= 100) {
                parsed.push({ field: 'label', includes: c.includes.trim() });
            } else if (
                c?.field === 'files_changed' &&
                typeof c.moreThan === 'number' &&
                Number.isInteger(c.moreThan) &&
                c.moreThan >= 0 &&
                c.moreThan <= 10_000
            ) {
                parsed.push({ field: 'files_changed', moreThan: c.moreThan });
            } else {
                return { ok: false, error: 'a condition is changed_paths { matches }, label { includes } or files_changed { moreThan }' };
            }
        }
        rules.push({ conditions: parsed });
    }
    return { ok: true, rules };
}

export interface PullRequestFacts {
    changedPaths: string[];
    /** The product could not list every changed file: there are more than `changedPaths` holds. */
    changedPathsTruncated?: boolean;
    labels: string[];
    /** The author is a bot or a coding agent (Claude Code, Codex, Devin, ...). */
    authorIsAgent: boolean;
    /** A push after the Run already ran on this PR. */
    isNewPush: boolean;
}

export interface RepositoryTriggerSettings {
    mode: RuntimeMode;
    rules: TriggerRule[];
    runOnAgentPullRequests: boolean;
    runOnNewPushes: boolean;
}

/** Whether one condition of a rule holds for the PR's facts. */
export const conditionHolds = (c: RuleCondition, pr: PullRequestFacts) => {
    switch (c.field) {
        case 'changed_paths': {
            const re = compileGlob(c.matches);
            return pr.changedPaths.some((p) => re.test(p));
        }
        case 'label':
            return pr.labels.some((l) => l.toLowerCase() === c.includes.toLowerCase());
        case 'files_changed':
            // A cut list has more files than it shows, so it is past any bound the cut reached.
            return pr.changedPaths.length > c.moreThan || (pr.changedPathsTruncated === true && pr.changedPaths.length >= c.moreThan);
    }
};

export type RunDecision =
    | { run: true; rule: number }
    | { run: false; reason: 'off' | 'on_request_only' | 'rule_not_matched' | 'bot_author' | 'new_pushes_off' };

/** Whether a pull request event runs the Runtime without anyone asking (a comment always asks). */
export function decideRun(settings: RepositoryTriggerSettings, pr: PullRequestFacts): RunDecision {
    if (settings.mode === 'off') return { run: false, reason: 'off' };
    if (settings.mode === 'on_request') return { run: false, reason: 'on_request_only' };
    if (pr.authorIsAgent && !settings.runOnAgentPullRequests) return { run: false, reason: 'bot_author' };
    if (pr.isNewPush && !settings.runOnNewPushes) return { run: false, reason: 'new_pushes_off' };
    const rule = settings.rules.findIndex((r) => r.conditions.every((c) => conditionHolds(c, pr)));
    return rule >= 0 ? { run: true, rule } : { run: false, reason: 'rule_not_matched' };
}
