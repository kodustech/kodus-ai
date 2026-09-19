/**
 * code-review (domain) — PLAN → SHARD: search the code the diff AFFECTS, not
 * just the code the diff CONTAINS.
 *
 * Every pass we have (generalist, scout+investigators, critical-file) reads the
 * same material: the diff. A caller that breaks because of the change lives in
 * a file the PR never touched, so it is only ever found if the model decides,
 * on its own, to go looking for it. Measured on the 30-PR light set, only ~20%
 * of true positives involved cross-file reasoning — while the golden comments
 * are full of "breaks the interface contract" / "callers were not updated".
 *
 * Shape from the agentic map-reduce writeup (devin.ai/blog/agentic-map-reduce):
 * an agent writes SELECTORS (deterministic relevance tests), those run over the
 * repository producing signals, and workers reason over the matches. The step
 * we never had is the search itself — our "shard" only ever ranked files that
 * were already in the diff.
 *
 * Why the LLM writes the queries: it is an EXTRACTION task ("which symbols did
 * this diff change?"), not the open judgment ("is this a bug?") that frontier
 * models answer with silence. A wrong query is cheap — grep returns nothing and
 * the worker never runs; a wrong scout flag burns a whole investigation.
 *
 * Requires real repository search: the eval's recorded fixtures can only answer
 * calls captured when the dataset was built, and a selector by definition asks
 * about code the diff does not contain (RECALL_REAL_REPO=1).
 */
import { z } from 'zod';
import { LLM } from '@libs/llm/llm';
import type { NormalizedModel } from '@libs/llm/byok-config';

/** Selectors per PR. 6 keeps the worker count at 3 (paired) — above the
 *  validated scout cap of 5, deliberately: a run that finds nothing because it
 *  was starved cannot tell us the technique fails. */
export const MAX_SELECTORS = 6;
/** Call sites per worker. Pairing halves the passes; they share a symbol, so
 *  the depth loss should be smaller than investigatorGroupByFile's (which
 *  merged unrelated flags and measured worse: F1 0.371 vs 0.432). */
export const SITES_PER_WORKER = 2;

export interface Selector {
    /** Literal string to search for across the repo (a symbol name, not a regex). */
    query: string;
    /** What changed about it — becomes the worker's verification task. */
    reason: string;
}

export interface SignalSite {
    file: string;
    line?: number;
    snippet: string;
    selector: Selector;
}

const PLAN_SCHEMA = z.object({
    selectors: z.array(
        z.object({
            query: z.string(),
            reason: z.string(),
        }),
    ),
});

/** Asks for symbols, not suspicions. */
export function buildPlanPrompt(userPrompt: string, cap: number = MAX_SELECTORS): string {
    return `${userPrompt}

<SelectorPlan>
  Ignore every rule and output format above. You are NOT reviewing this diff and
  NOT looking for bugs — a later pass does that.

  Your only job: list the symbols this diff CHANGED that code elsewhere in the
  repository might depend on, so we can go read that code.

  Name up to ${cap} of them. For each:
    - query:  the exact identifier to search for — a function, method, class,
              constant, field or route name. One literal string, no regex, no
              file paths, no prose.
    - reason: what changed about it, in one sentence ("return type is now
              nullable", "parameter order changed", "guard added before the
              write", "field removed from the response").

  Pick the ones whose change could break a caller: signatures, return types,
  nullability, contracts, field shapes, side effects that disappeared. Skip
  purely internal edits nothing outside could observe (renamed locals, comments,
  formatting), and skip identifiers so generic that searching them is useless
  ("data", "result", "handler").

  If this diff changes nothing observable from outside, return an empty list.
</SelectorPlan>`;
}

/** One-shot, no tools — same shape as runScout. */
export async function runPlan(
    prompt: string,
    byokConfig: NormalizedModel | undefined,
    organizationId: string | undefined,
    usageRunName?: string,
    cap: number = MAX_SELECTORS,
): Promise<Selector[]> {
    try {
        const result = await LLM.run({
            byokConfig,
            schema: PLAN_SCHEMA,
            user: prompt,
            runName: usageRunName ? `${usageRunName}-plan` : 'code-review-plan',
            organizationId,
        });
        const selectors = (result.selectors as Selector[] | undefined) ?? [];
        return selectors
            .filter((s) => s?.query && s.query.trim().length >= 3)
            .slice(0, cap);
    } catch {
        // Best-effort: a broken plan must not break the review running around it.
        return [];
    }
}

/** grep output ("path:line:text" per line) → structured sites, minus anything
 *  inside the diff itself (already reviewed by every other pass). */
export function parseSignals(
    rawGrep: string,
    selector: Selector,
    changedFiles: string[],
): SignalSite[] {
    const changed = new Set(changedFiles.map((f) => f.replace(/^\/+/, '').toLowerCase()));
    const out: SignalSite[] = [];
    for (const line of String(rawGrep || '').split('\n')) {
        if (!line.trim()) continue;
        const m = line.match(/^(.+?):(\d+):(.*)$/);
        if (!m) continue;
        const [, rawPath, lineNo, text] = m;
        const file = rawPath.replace(/^\.\//, '').replace(/^\/+/, '');
        if (changed.has(file.toLowerCase())) continue;
        // Definitions and imports are not call sites — the interesting signal is
        // code that USES the symbol.
        if (/^\s*(import|from|#include|require\()/.test(text)) continue;
        out.push({ file, line: Number(lineNo), snippet: text.trim().slice(0, 200), selector });
    }
    return out;
}

/**
 * The worker's task. Scoped to "does this change break it?" and NOT "is this
 * code correct?" — searching outside the diff otherwise surfaces pre-existing
 * bugs the PR did not introduce, which are false positives both for the
 * benchmark and for the person reading the PR.
 *
 * MEASURED AND REJECTED — a directed checklist in place of that question.
 * Of the 30 golden comments no configuration has ever found, 6 are
 * caller-contract breaks, and the tool calls show the agent had already reached
 * the symbol in 4 of them: it stood in the right file and said nothing. So the
 * loss looked like reasoning rather than reach, and the fix looked obvious —
 * replace the open question with seven named checks (signature, async, return,
 * fields, contract, behaviour, anything-else) and delete the "submit an empty
 * suggestions array" escape hatch, on the theory that an explicit empty-output
 * option invites abstention.
 *
 * It measured WORSE on the same 30 PRs: recall 35.8% -> 30.4%, precision 50.0%
 * -> 45.9%, F1 0.417 -> 0.366. Six true positives lost, well outside the
 * harness's +-1pp recall noise. The reading that fits: the checklist anchors
 * the search instead of widening it, and answering seven items costs the steps
 * the worker would have spent investigating — the median pass only runs five.
 *
 * Restored to the open question. Do not re-derive the checklist idea from the
 * "4 of 6 were already there" observation without also reading this paragraph.
 */
export function buildShardWorkerPrompt(userPrompt: string, sites: SignalSite[]): string {
    const items = sites
        .map(
            (s, i) =>
                `  ${i + 1}. ${s.file}:${s.line ?? '?'}\n` +
                `     uses: ${s.selector.query} — ${s.selector.reason}\n` +
                `     code: ${s.snippet}`,
        )
        .join('\n\n');

    return `${userPrompt}

<AffectedCode>
  The diff above changed some symbols. These places OUTSIDE the diff use them:

${items}

  For each one, answer a single question: does the change in this PR break it?

  Read the file and the changed code with the tools before deciding. Report a
  defect only when the change is what causes it — the code worked before this
  PR and does not work after. Concretely, this means things like: a caller that
  does not handle the newly-nullable return, an argument that no longer matches
  the signature, an assumption the new guard invalidates, a field the caller
  still reads after it was removed.

  Do NOT report a problem that already existed before this PR, however real it
  looks — it is not this PR's doing and does not belong in this review.

  Anchor every finding to the line the DIFF changed (that is the fix site), and
  name the affected location in the description.

  If none of these break, submit an empty suggestions array.
</AffectedCode>`;
}

/** Cap first, then pair: the cap bounds cost, the pairing halves the passes. */
export function groupSites(
    sites: SignalSite[],
    cap: number = MAX_SELECTORS,
    perWorker: number = SITES_PER_WORKER,
): SignalSite[][] {
    // One site per file per selector: N hits in the same file are usually the
    // same usage pattern, and spending a worker on each crowds out other files.
    const seen = new Set<string>();
    const deduped: SignalSite[] = [];
    for (const s of sites) {
        const key = `${s.selector.query}::${s.file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(s);
    }
    const picked = deduped.slice(0, cap);
    const groups: SignalSite[][] = [];
    for (let i = 0; i < picked.length; i += perWorker) {
        groups.push(picked.slice(i, i + perWorker));
    }
    return groups;
}

/* ------------------------------------------------------------------------ *
 * GRAPH-DERIVED SELECTORS — the same sites, without the LLM plan or the grep.
 *
 * `runPlan` asks a model to guess which symbols matter, then `parseSignals`
 * greps for the name and throws away whatever looks wrong. The AST graph
 * production already builds answers both questions directly: which symbols the
 * diff changed, and which code outside the diff depends on them, resolved by
 * the parser instead of by string match.
 *
 * Two things it finds that the grep path structurally cannot:
 *   - USES_TYPE / INHERITS dependents. Searching a function name never surfaces
 *     a file that only names its TYPE. On the keycloak caching case, 5 of the 6
 *     direct dependents were USES_TYPE.
 *   - the difference between a call site and a coincidence. `parseSignals` drops
 *     import lines by regex precisely because grep cannot tell them apart.
 *
 * Requires the repo-wide baseline graph (production: the Postgres AST index;
 * eval: `parse --all` at the base commit). Without it the graph only holds the
 * changed files and every dependent list comes back empty.
 * ------------------------------------------------------------------------ */

interface GraphNode {
    qualified_name: string;
    name: string;
    kind?: string;
    file_path: string;
    line_start?: number;
}

interface GraphEdge {
    kind: string;
    source_qualified: string;
    target_qualified: string;
}

interface ChangedFunction {
    qualified_name: string;
    name: string;
    signature?: string;
    file_path: string;
    is_new?: boolean;
    caller_impact?: string;
    diff_changes?: string[];
    contract_diffs?: { field: string; old_value?: string; new_value?: string }[];
}

interface BlastEntry {
    qualified_name: string;
    edge_kind: 'CALLS' | 'IMPORTS' | 'USES_TYPE' | 'INHERITS';
    impact_score?: number;
    impact_category?: string;
}

export interface CallGraphContext {
    graph?: { nodes?: GraphNode[]; edges?: GraphEdge[] };
    analysis?: {
        changed_functions?: ChangedFunction[];
        blast_radius?: { by_depth?: Record<string, BlastEntry[]> };
    };
}

/** How the dependent reaches the change — the worker needs this to know what
 *  kind of breakage to look for. */
const EDGE_PHRASING: Record<string, string> = {
    CALLS: 'calls it',
    IMPORTS: 'imports it',
    USES_TYPE: 'names its type in a signature or declaration',
    INHERITS: 'inherits from it',
};

/** `diff_changes` are raw field tags from the structural diff (see
 *  kodus-graph's analysis/diff.ts), not prose. Handed through verbatim they
 *  reach the worker as `reason: body`, which tells it nothing. */
const CHANGE_PHRASING: Record<string, string> = {
    body: 'its implementation changed',
    params: 'its parameters changed',
    return_type: 'its return type changed',
    modifiers: 'its visibility or modifiers changed',
    is_async: 'it switched between sync and async',
    decorators: 'its decorators changed',
    throws: 'the exceptions it throws changed',
    line_range: 'it moved or was resized',
};

function fallbackNode(qualifiedName: string): GraphNode | null {
    const at = qualifiedName.indexOf('::');
    if (at <= 0) return null;
    return {
        qualified_name: qualifiedName,
        name: qualifiedName.slice(at + 2),
        file_path: qualifiedName.slice(0, at),
    };
}

/** What changed, in the most specific form the graph can state. Falls back
 *  down the chain rather than emitting a vague "it was modified", which gives
 *  the worker nothing to test against. */
function describeChange(fn: ChangedFunction): string {
    if (fn.caller_impact) return fn.caller_impact;

    const contract = (fn.contract_diffs || [])
        .map((d) => {
            const from = d.old_value ? ` (was ${d.old_value})` : '';
            return `${d.field} is now ${d.new_value ?? 'different'}${from}`;
        })
        .join('; ');
    if (contract) return contract;

    if (fn.is_new) return 'newly added in this PR';

    const tagged = (fn.diff_changes || [])
        .map((c) => CHANGE_PHRASING[c] || `its ${c} changed`)
        .join('; ');
    return tagged || 'it was modified in this PR';
}

/**
 * Blast-radius entries -> shard sites.
 *
 * @param maxDepth 1 is direct dependents only. Depth 2+ is transitive CALLS
 *   (86 entries on the keycloak case against 6 at depth 1) — reachable, but the
 *   further from the change, the weaker the claim that this PR broke it.
 */
export function sitesFromCallGraph(
    ctx: CallGraphContext | null | undefined,
    changedFiles: string[],
    maxDepth: number = 1,
): SignalSite[] {
    const byDepth = ctx?.analysis?.blast_radius?.by_depth;
    const changedFns = ctx?.analysis?.changed_functions || [];
    if (!byDepth || !changedFns.length) return [];

    const nodes = new Map(
        (ctx?.graph?.nodes || []).map((n) => [n.qualified_name, n]),
    );
    const changedByQN = new Map(changedFns.map((f) => [f.qualified_name, f]));
    const changed = new Set(
        changedFiles.map((f) => f.replace(/^\/+/, '').toLowerCase()),
    );

    // Anything the diff touched, not just the enriched functions:
    // `enrichChangedFunctions` drops Class/Interface/Enum nodes, and a
    // USES_TYPE dependent points at the CLASS. Matching only functions lost
    // half the sites on the keycloak case for no reason.
    const inDiff = (qn: string): boolean => {
        const n = nodes.get(qn);
        return !!n && changed.has(
            n.file_path.replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase(),
        );
    };

    // Which changed symbol reaches a given dependent. Edge direction differs by
    // kind (a caller points AT the callee; a subclass points at its parent), so
    // match either end and keep whichever side is the changed one. A function
    // match wins over a bare node — it carries the contract diff.
    const reaches = new Map<string, { fn?: ChangedFunction; node?: GraphNode }>();
    const note = (dependent: string, changedQN: string) => {
        const fn = changedByQN.get(changedQN);
        const prev = reaches.get(dependent);
        if (prev?.fn && !fn) return;
        reaches.set(dependent, { fn, node: nodes.get(changedQN) });
    };
    for (const e of ctx?.graph?.edges || []) {
        if (e.kind === 'CONTAINS') continue;
        if (inDiff(e.target_qualified) && !inDiff(e.source_qualified)) {
            note(e.source_qualified, e.target_qualified);
        } else if (inDiff(e.source_qualified) && !inDiff(e.target_qualified)) {
            note(e.target_qualified, e.source_qualified);
        }
    }

    const ranked: { site: SignalSite; score: number }[] = [];
    for (let depth = 1; depth <= maxDepth; depth++) {
        for (const entry of byDepth[String(depth)] || []) {
            // A qualified_name is "<path>::<symbol>", so the file survives even
            // when the node itself was trimmed out of the cached graph (the
            // eval drops a graph too large to hold in memory). Only the line
            // number is lost, and the worker reads the file anyway.
            const node =
                nodes.get(entry.qualified_name) ??
                fallbackNode(entry.qualified_name);
            if (!node?.file_path) continue;

            const file = node.file_path.replace(/^\.\//, '').replace(/^\/+/, '');
            // Everything inside the diff is already in the agent's prompt.
            if (changed.has(file.toLowerCase())) continue;

            // With no edges cached there is nothing to attribute the site to,
            // but the dependency itself is still real — keep the site and say
            // less, rather than dropping it.
            const hit = reaches.get(entry.qualified_name) ?? (nodes.size ? null : {});
            if (!hit) continue;

            const how = EDGE_PHRASING[entry.edge_kind] || 'depends on it';
            ranked.push({
                score: (entry.impact_score ?? 0) / depth,
                site: {
                    file,
                    line: node.line_start,
                    snippet: `${node.kind || 'symbol'} ${node.name} — ${how}`,
                    selector: {
                        query: hit.fn?.name || hit.node?.name || 'the changed code',
                        reason: hit.fn
                            ? describeChange(hit.fn)
                            : 'it was changed in this PR',
                    },
                },
            });
        }
    }

    return ranked
        .sort((a, b) => b.score - a.score)
        .map((r) => r.site);
}
