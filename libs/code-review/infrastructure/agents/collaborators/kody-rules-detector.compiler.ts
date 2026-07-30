/**
 * T0 detector compiler + gate for kody-rules (issue #1449).
 *
 * A mechanical rule (no-console, no-debugger, deep-relative-import, …) does not
 * need an LLM at review time: it's a pattern over added lines. This compiles
 * such a rule ONCE (at authoring) into a deterministic detector, so review-time
 * runs pure code — the biggest cost lever, and the one part that stays free
 * regardless of the customer's BYOK model.
 *
 * SAFETY — the gate. An LLM writes the regex, but it never ships unchecked:
 *   1. it must reproduce the rule's own `incorrect` examples (recall), and
 *   2. it must NOT flag the rule's `correct` examples (precision), and
 *   3. (optional) it must not over-match a corpus of real code (false-positive
 *      rate below a threshold).
 * If any check fails, the rule is DECLINED → it falls back to the semantic
 * judge (T1). A weak/unknown BYOK model can therefore only reduce how many
 * rules get the free T0 treatment — never produce a wrong detector. Validated
 * on evals/kody-rules/detector-compiler-eval.js (98% behavioral recall, 6/6
 * semantic refusals on a capable model; a small model degrades to fewer-but-
 * still-safe T0 rules once the gate runs).
 *
 * The LLM call is injected (`runCompiler`) so this is unit-testable without a
 * live model. Detector representation starts as a single regex; the multi-clause
 * DSL (any/all/unless/ast) is a later extension of `DetectorPlan`.
 */
import { z } from 'zod';
import {
    IKodyRule,
    IKodyRuleDetector,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { ruleAppliesToFile } from '@libs/code-review/infrastructure/agents/collaborators/kody-rules-sharded.judge';

// ── the LLM side of the compiler (runs once at authoring) ────────────────────

/**
 * System prompt for the compile call. The INPUT-CONTRACT block is load-bearing:
 * without it, models anchor the regex to diff markers ('+', line numbers) and
 * the detector matches nothing (measured — gpt-5.4-mini went 29%→100% recall
 * once the contract was made explicit). Making it explicit removes the
 * model-dependence, which matters because on self-hosted the compiler runs on
 * the customer's BYOK model.
 */
export const COMPILER_SYSTEM_PROMPT = `You compile a team code-review rule into a deterministic detector, or decline.

A rule is MECHANICAL only if a single-line regular expression over the ADDED lines of a diff can detect every violation with high precision — no surrounding context, no cross-line or cross-file reasoning, no judgment about intent, naming quality, or whether something "should" exist elsewhere.

INPUT CONTRACT (critical): your regex is applied by the engine to the raw CONTENT of ONE added line of source code — the code text ONLY. Every diff marker is already stripped: there is NO leading '+', NO line number, NO '@@' header. So:
- Match the code itself (e.g. \`console\\.(log|warn|error)\\s*\\(\`).
- NEVER anchor to a '+' or a line-number prefix (do NOT write \`^\\+\` or \`^\\s*\\d+\`). Those never match.
- Assume single-line matching; you cannot see other lines.

If mechanical, emit a JavaScript-compatible regex (source only, no slashes) that matches a violating line of code CONTENT.
If not mechanical, decline — a wrong regex silently hides violations, which is worse than routing the rule to the LLM reviewer. When unsure, decline.

Return ONLY JSON: {"mechanical": true, "pattern": "<regex source>", "flags": "<optional>", "reason": "<one sentence>"} or {"mechanical": false, "reason": "<one sentence>"}`;

export const compilerOutputSchema = z.object({
    mechanical: z.boolean(),
    pattern: z.string().optional(),
    flags: z.string().optional(),
    reason: z.string().optional(),
});

export function buildCompilerUserPrompt(rule: Partial<IKodyRule>): string {
    const parts = [
        `<Rule>`,
        `Title: ${rule.title}`,
        `Description: ${rule.rule}`,
    ];
    if (rule.examples?.length) {
        parts.push(`Examples:`);
        for (const ex of rule.examples) {
            parts.push(
                `- ${ex.isCorrect ? 'correct' : 'incorrect'}: ${JSON.stringify(ex.snippet)}`,
            );
        }
    }
    parts.push(`</Rule>`, ``, `Compile this rule or decline. Return ONLY the JSON.`);
    return parts.join('\n');
}

/**
 * Adapt a raw LLM call (returning the compiler JSON) into the `RunCompiler`
 * the gate consumes. The engine passes a closure backed by
 * PromptRunnerService.builder().setParser(ParserType.ZOD, compilerOutputSchema);
 * tests pass a stub.
 */
export function makeLLMRunCompiler(
    call: (args: {
        system: string;
        user: string;
    }) => Promise<CompilerOutput | null>,
): RunCompiler {
    return (rule) =>
        call({
            system: COMPILER_SYSTEM_PROMPT,
            user: buildCompilerUserPrompt(rule),
        });
}

/** The compiled detector stored on the rule (single source of truth: domain). */
export type DetectorPlan = IKodyRuleDetector;

/** Raw compiler output from the LLM (before the gate). */
export interface CompilerOutput {
    mechanical: boolean;
    pattern?: string;
    flags?: string;
    reason?: string;
}

/**
 * The injected single-shot LLM call: given a rule, decide mechanical-vs-semantic
 * and (if mechanical) emit a regex. Tests inject a stub. The engine wires it to
 * the customer's / Kodus's model.
 */
export type RunCompiler = (
    rule: Partial<IKodyRule>,
) => Promise<CompilerOutput | null>;

export interface CompileOptions {
    /** unlabeled real-code lines to stress-test false-positive rate. */
    corpus?: string[];
    /** reject a detector matching more than this fraction of the corpus. */
    maxCorpusMatchRate?: number;
    /** label for `compiledBy`. */
    modelName?: string;
}

export interface CompileResult {
    /** the safe-to-ship detector, or null when the rule stays semantic. */
    detector: DetectorPlan | null;
    /** why it was declined/downgraded (for observability). */
    declineReason?:
        | 'not-mechanical'
        | 'invalid-regex'
        | 'unsafe-regex'
        | 'missed-incorrect-example'
        | 'flagged-correct-example'
        | 'over-matches-corpus'
        | 'no-usable-examples';
}

/** Longest detector pattern we persist. A compiled rule is a simple line
 *  matcher; anything longer is more likely an unbounded/backtracking construct
 *  than a legitimate detector. */
const MAX_PATTERN_LEN = 200;

/**
 * Reject regex shapes prone to catastrophic backtracking (ReDoS). An LLM (or a
 * malicious rule author) can pass the example/corpus gate with a pattern like
 * `(a+)+$` that still hangs on a long adversarial line at review time. This is
 * a conservative heuristic — a quantifier applied to a group/class that itself
 * contains a quantifier — plus a length cap. Rejected patterns fall back to the
 * semantic judge; combined with the per-line length cap in runDetector, a
 * shipped detector can't blow up review time.
 */
export function isDetectorRegexSafe(pattern: string): boolean {
    if (!pattern || pattern.length > MAX_PATTERN_LEN) return false;
    // Nested quantifier: a group or char-class that itself contains a
    // quantifier-ish char (+/*/}), followed by an outer quantifier —
    // the classic ReDoS shape. The outer quantifier must be matched in
    // full (*, +, {n,}, {n,m}) — an earlier version only matched a bare
    // `*`/`+` right after the group, so bounded forms like `(a+){3,}` or
    // `(a*){5}` (both valid, both still catastrophic) slipped through.
    // The char-class branch requires the SAME inner-quantifier-char
    // check as the group branch — without it, this flagged every
    // ordinary `[a-z]+`-shaped detector as unsafe, which would have
    // declined nearly every char-class-based pattern.
    const NESTED_QUANTIFIER =
        /(\([^()]*[+*}][^()]*\)|\[[^\]]*[+*}][^\]]*\])\s*([*+]|\{\d+,?\d*\})/;
    return !NESTED_QUANTIFIER.test(pattern);
}

/** Extract the content of one added diff line from a `NN +code` shard line. */
function addedLineContent(line: string): string | null {
    const m = line.match(/^\s*\d+\s*\+(.*)$/);
    return m ? m[1] : null;
}

/**
 * The COMPILE-TIME gate: compile the rule and only promote to T0 if the emitted
 * regex reproduces the rule's own examples (and, if provided, doesn't over-match
 * a code corpus). Otherwise decline → the rule stays on the semantic judge.
 */
export async function compileRuleDetector(
    rule: Partial<IKodyRule>,
    runCompiler: RunCompiler,
    opts: CompileOptions = {},
): Promise<CompileResult> {
    const out = await runCompiler(rule);
    if (!out || out.mechanical !== true || !out.pattern) {
        return { detector: null, declineReason: 'not-mechanical' };
    }

    let rx: RegExp;
    try {
        rx = new RegExp(out.pattern, out.flags || '');
    } catch {
        return { detector: null, declineReason: 'invalid-regex' };
    }

    // ReDoS guard: never persist a backtracking-prone pattern (it would run on
    // every added line at review time). Decline → semantic judge.
    if (!isDetectorRegexSafe(out.pattern)) {
        return { detector: null, declineReason: 'unsafe-regex' };
    }

    // Gate 1+2: the rule's own labeled examples. Examples may be full snippets
    // (multi-line) or single lines — test each line of a snippet.
    const examples = rule.examples ?? [];
    const bad = examples.filter((e) => e && e.isCorrect === false && e.snippet);
    const good = examples.filter((e) => e && e.isCorrect === true && e.snippet);
    const anyLineMatches = (snippet: string) =>
        snippet.split('\n').some((ln) => {
            rx.lastIndex = 0;
            return rx.test(ln);
        });

    if (bad.length === 0 && good.length === 0) {
        // No labeled signal: we cannot safely promote a loose regex. Default to
        // semantic unless a corpus is provided (precision-only) — conservative.
        if (!opts.corpus?.length) {
            return { detector: null, declineReason: 'no-usable-examples' };
        }
    }
    // recall: every incorrect example must be flagged.
    for (const e of bad) {
        if (!anyLineMatches(e.snippet)) {
            return { detector: null, declineReason: 'missed-incorrect-example' };
        }
    }
    // precision: no correct example may be flagged.
    for (const e of good) {
        if (anyLineMatches(e.snippet)) {
            return { detector: null, declineReason: 'flagged-correct-example' };
        }
    }

    // Gate 3 (optional): corpus false-positive rate. Real violations are rare in
    // ordinary code, so a detector lighting up a large share of the corpus is
    // too loose (e.g. `\bany\b` matching the word "any" everywhere).
    if (opts.corpus?.length) {
        const threshold = opts.maxCorpusMatchRate ?? 0.02; // 2%
        let hits = 0;
        for (const ln of opts.corpus) {
            rx.lastIndex = 0;
            if (rx.test(ln)) hits++;
        }
        if (hits / opts.corpus.length > threshold) {
            return { detector: null, declineReason: 'over-matches-corpus' };
        }
    }

    return {
        detector: {
            type: 'regex',
            pattern: out.pattern,
            flags: out.flags,
            compiledBy: opts.modelName,
            reason: out.reason,
        },
    };
}

/** Skip absurdly long added lines when running detectors — a ReDoS input
 *  bound (real source lines are short; minified blobs aren't rule targets). */
const MAX_MATCH_LINE_LEN = 2000;

/** One detector match at review time. */
export interface DetectorHit {
    filename: string;
    line: number;
    code: string;
}

/**
 * REVIEW-TIME execution: run a compiled detector over the ADDED lines of the
 * changed files. Pure code, no LLM. The hits are candidates — a cheap
 * confirm-on-hits LLM pass filters false positives and writes the comment.
 */
export function runDetector(
    plan: DetectorPlan,
    changedFiles: Array<{ filename: string; patchWithLinesStr?: string; patch?: string }>,
): DetectorHit[] {
    let rx: RegExp;
    try {
        rx = new RegExp(plan.pattern, plan.flags || '');
    } catch {
        return [];
    }
    const hits: DetectorHit[] = [];
    for (const f of changedFiles) {
        const diff = f.patchWithLinesStr ?? f.patch ?? '';
        for (const raw of diff.split('\n')) {
            const m = raw.match(/^\s*(\d+)\s*\+(.*)$/);
            if (!m) continue;
            const line = Number(m[1]);
            const code = m[2];
            // Belt-and-suspenders ReDoS bound: a pathological line can't feed
            // a huge input to the matcher even if a bad pattern slipped the
            // compile-time guard. Real code lines are short; skip absurd ones.
            if (code.length > MAX_MATCH_LINE_LEN) continue;
            rx.lastIndex = 0;
            if (Number.isFinite(line) && rx.test(code)) {
                hits.push({ filename: f.filename, line, code });
            }
        }
    }
    return hits;
}

/** A detector-produced finding, shaped like the judge's ShardViolation so the
 *  provider can merge both streams into one mapAgentFindings call. */
export interface DetectorViolation {
    ruleUuid: string;
    relevantFile: string;
    relevantLinesStart: number;
    relevantLinesEnd: number;
    existingCode: string;
    suggestionContent: string;
    oneSentenceSummary: string;
}

/**
 * T0 review-time: for every rule that carries a compiled detector, run it over
 * the ADDED lines of the path-applicable changed files and emit one finding per
 * hit. Pure code — no LLM. (A confirm-on-hits LLM pass to filter residual false
 * positives + polish the comment is a later refinement; the compile-time gate
 * already bounds precision.)
 */
export function buildDetectorViolations(
    rules: Array<Partial<IKodyRule>>,
    changedFiles: FileChange[],
): DetectorViolation[] {
    const out: DetectorViolation[] = [];
    for (const rule of rules) {
        if (!rule.detector || !rule.uuid) continue;
        const files = changedFiles.filter((f) =>
            ruleAppliesToFile(f.filename, rule.path),
        );
        for (const h of runDetector(rule.detector, files)) {
            out.push({
                ruleUuid: rule.uuid,
                relevantFile: h.filename,
                relevantLinesStart: h.line,
                relevantLinesEnd: h.line,
                existingCode: h.code,
                suggestionContent: `Violates team rule '${rule.title}': ${rule.rule}`,
                oneSentenceSummary: `Violates '${rule.title}'`,
            });
        }
    }
    return out;
}
