/**
 * Deterministic sharded judge for kody-rules (issue #1449).
 *
 * The agentic KodyRulesAgentProvider under-covers because it lets the LLM
 * decide which files to open inside a turn budget; on large PRs the violating
 * file is never read (measured: gpt-5.4 40%, kimi 58% occurrence-recall).
 *
 * This replaces the traversal with a DETERMINISTIC sweep: code iterates every
 * changed file × its path-applicable rules and issues ONE single-shot LLM call
 * per file with those rules batched in. Coverage becomes a structural guarantee
 * — the model only judges "does this diff violate these rules?", never decides
 * where to look. Validated on the frozen github-cases benchmark: 91-100%
 * occurrence-recall across gpt-5.4 / gpt-5.4-mini / kimi, ~same-or-lower cost.
 *
 * Pure orchestration: the LLM call is injected as `runJudge` so this is
 * unit-testable against replayed diffs without a live model (same contract the
 * evals use). PR-level rules (scope: pull_request) get one whole-PR call.
 *
 * Out of scope here (later phases): the T0 regex compiler, T2 reference-file
 * inlining, hybrid regex+judge, compound-rule decomposition.
 */
import { jsonSchema, type Schema } from 'ai';
import { z } from 'zod';
import { recoverRuleUuid } from './finding-mapper';
import {
    extensionScopeAppliesToFile,
    fileMatchesRulePath,
} from '@libs/common/utils/kody-rules/file-patterns';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    IKodyRule,
    KodyRulesScope,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
// Type-only: the compiler imports `ruleAppliesToFile` from THIS module, so a
// value import back would close a runtime require cycle.
import type { DetectorHitIndex } from '@libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler';
import type { RetrievedSlice } from '@libs/code-review/infrastructure/agents/collaborators/rule-context.retriever';

/**
 * Parser schema for a shard's JSON output. The provider passes this to
 * `.setParser(ParserType.ZOD, shardViolationsSchema)` so a malformed model
 * response is retried/repaired by the runner before it reaches us.
 */
/**
 * Required-but-nullable wire field. OpenAI structured outputs (strict
 * json_schema) reject any schema whose `required` array doesn't list every
 * key in properties — `.optional()` fields made the API 400 instantly
 * ("Missing 'relevantLinesStart'"), silently killing every shard for
 * BYOK-OpenAI orgs. This keeps the key in `required` (anyOf [T, null])
 * while mapping a lenient provider's omitted key to null; a WRONG-typed
 * value still fails parse (surfaced by the shard-error log) instead of
 * being silently nulled.
 */
const nullableWire = <T extends z.ZodType>(inner: T) =>
    z.preprocess(
        (v) => (v === undefined ? null : v),
        z.union([inner, z.null()]),
    );

/**
 * Line-number variant of nullableWire: models occasionally emit line numbers
 * as numeric STRINGS ("42"), and one such value would fail the whole shard
 * parse and degrade it to zero findings. Coerce numeric strings in the
 * preprocess (NOT via z.coerce, which would also turn the null this helper
 * produces — and '' — into 0); non-numeric garbage still fails parse and is
 * surfaced by the shard-error log. Wire schema stays anyOf [number, null].
 */
const nullableWireLine = z.preprocess(
    (v) => {
        if (v === undefined || v === null) return null;
        if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) {
            return Number(v.trim());
        }
        return v;
    },
    z.union([z.number(), z.null()]),
);

/**
 * The assertion families a deterministic repository check can actually refute
 * (issue #1826). `none` is the everything-else bucket: published unchanged,
 * exactly as today.
 */
export const SHARD_CLAIM_KINDS = [
    'unused',
    'missing',
    'duplicate',
    'none',
] as const;

export type ShardClaimKind = (typeof SHARD_CLAIM_KINDS)[number];

/**
 * Claim-kind wire field. Same required-but-nullable shape as `nullableWire`,
 * plus one extra guarantee: an off-vocabulary value NEVER fails the shard
 * parse. A single invented kind ("removed", "shadowed") would otherwise take
 * the whole file's findings down with it, which is a far worse trade than
 * publishing that one finding unchecked — so anything that is a string but not
 * in the vocabulary (including '' and whitespace) normalizes to `none`, i.e.
 * "no claim, publish unchanged" (KRC-09). A non-string stays null, the same
 * absent-key semantics every other nullable field on this schema has.
 */
const nullableWireClaimKind = z.preprocess(
    (v) => {
        if (typeof v !== 'string') return null;
        const kind = v.trim().toLowerCase();
        return (SHARD_CLAIM_KINDS as readonly string[]).includes(kind)
            ? kind
            : 'none';
    },
    z.union([z.enum(SHARD_CLAIM_KINDS), z.null()]),
);

/**
 * Claim-target wire field (`claimSymbol` / `claimPath`). A claim naming an
 * empty or whitespace-only target names nothing, so it collapses to null and
 * the checker has nothing to verify (KRC-21).
 */
const nullableWireClaimTarget = z.preprocess(
    (v) => {
        if (typeof v !== 'string') return v === undefined ? null : v;
        const trimmed = v.trim();
        return trimmed === '' ? null : trimmed;
    },
    z.union([z.string(), z.null()]),
);

export const shardViolationsSchema = z.object({
    violations: z
        .array(
            z.object({
                // The rule the model is flagging, identified by its 1-based
                // index ([n]) in this shard's rule list. We accept a bare
                // number, a stringified number, or — as a graceful fallback if
                // the model reverts to old behavior — a UUID string. The union
                // tries the numeric coercion first; a UUID (non-numeric) falls
                // through to the string arm. See #1170 for why we stopped
                // asking the model to echo UUIDs.
                // Range/int validation of ruleId lives in resolveRuleId, which
                // drops out-of-range indices — keep the wire schema minimal so
                // strict mode has fewer keywords to reject.
                ruleId: z.union([z.coerce.number(), z.string()]),
                relevantLinesStart: nullableWireLine,
                relevantLinesEnd: nullableWireLine,
                language: nullableWire(z.string()),
                existingCode: nullableWire(z.string()),
                improvedCode: nullableWire(z.string()),
                suggestionContent: z.string(),
                oneSentenceSummary: nullableWire(z.string()),
                // Flat, never nested (issue #1826). A nested `claim` object
                // multiplies the strict-mode `required` surface that already
                // 400-ed every shard twice (#1523/#1526) for zero gain.
                claimKind: nullableWireClaimKind,
                claimSymbol: nullableWireClaimTarget,
                claimPath: nullableWireClaimTarget,
            }),
        )
        .default([]),
});

/**
 * WIRE schema for the shard call — what the provider actually sends as
 * `response_format`. This CANNOT be the zod object above passed directly:
 * the AI SDK's `zodSchema()` derives the JSON schema from the zod INPUT
 * side, and the preprocess fields accept `undefined` there, so the SDK
 * drops them from `required` — recreating the exact OpenAI-strict 400
 * ("Missing 'relevantLinesStart'") this schema exists to prevent (observed
 * live on the first fix attempt). Hand the SDK the OUTPUT-side JSON schema
 * (every key required, nullable via anyOf) and keep the lenient zod parse
 * as the validate step.
 */
export const shardViolationsWireSchema: Schema<
    z.infer<typeof shardViolationsSchema>
> = jsonSchema(
    z.toJSONSchema(shardViolationsSchema, {
        target: 'draft-7',
        io: 'output',
    }) as any,
    {
        validate: (value) => {
            const r = shardViolationsSchema.safeParse(value);
            return r.success
                ? { success: true, value: r.data }
                : { success: false, error: r.error };
        },
    },
);

/**
 * A violation exactly as the model emits it (pre-resolution): the rule is a
 * `ruleId` index, not a UUID. `judgeKodyRulesSharded` resolves it to a real
 * `ruleUuid` before returning `ShardViolation`s.
 */
export interface RawShardViolation {
    ruleId: number | string;
    // `null` when a strict-schema provider (OpenAI structured outputs) fills
    // a required-but-inapplicable key; normalized to undefined on resolution.
    relevantLinesStart?: number | null;
    relevantLinesEnd?: number | null;
    language?: string | null;
    suggestionContent: string;
    existingCode?: string | null;
    improvedCode?: string | null;
    oneSentenceSummary?: string | null;
    claimKind?: ShardClaimKind | null;
    claimSymbol?: string | null;
    claimPath?: string | null;
}

/** A resolved violation for a (file, rule) pair — `ruleId` mapped to a UUID. */
export interface ShardViolation {
    ruleUuid: string;
    relevantFile?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    language?: string;
    suggestionContent: string;
    existingCode?: string;
    improvedCode?: string;
    oneSentenceSummary?: string;
    /**
     * What this finding asserts about the repository, if anything the claim
     * checker can refute (issue #1826). Absent or `none` = nothing to check.
     */
    claimKind?: ShardClaimKind;
    claimSymbol?: string;
    claimPath?: string;
}

/**
 * The injected single-shot LLM call. The provider supplies a closure backed by
 * `runStructuredReviewCall` (the AI SDK path, so it runs on the customer's BYOK
 * model); tests supply a replay. Returns the parsed violations for this shard,
 * or [] on a parse/LLM miss (the caller counts errors separately).
 */
export type RunJudge = (args: {
    system: string;
    user: string;
    /** file the shard covers, or null for the PR-level shard. */
    filename: string | null;
    /**
     * Rule uuids in scope for this shard, in the SAME order they are presented
     * to the model — so a `ruleId` index N maps to `ruleUuids[N-1]`. Also the
     * known set for the UUID-echo fallback.
     */
    ruleUuids: string[];
}) => Promise<RawShardViolation[]>;

/**
 * Max concurrent shard calls, and the single source for anything that must not
 * outpace the shards — the claim checker imports it rather than repeating the
 * number, so the two cannot drift apart (KRC-07). BYOK models rate-limit, so
 * keep it modest.
 */
export const SHARD_CONCURRENCY_DEFAULT = 4;

export interface ShardedJudgeInput {
    changedFiles: FileChange[];
    /** active, non-memory STANDARD rules already resolved for this review. */
    rules: Array<Partial<IKodyRule>>;
    runJudge: RunJudge;
    prTitle?: string;
    prBody?: string;
    /** max concurrent shard calls (BYOK models rate-limit — keep modest).
     *  Defaults to SHARD_CONCURRENCY_DEFAULT. */
    concurrency?: number;
    /** Errored shards degrade to zero findings; log WHY so a systemic
     *  failure (e.g. a provider rejecting the response schema) is visible
     *  in the worker logs instead of only as an `N errored` counter. */
    logger?: { warn: (entry: any) => void };
    /**
     * Human-readable language label (e.g. "Portuguese (Brazil)"), already
     * resolved via `resolveLanguageLabel` in prompt-builder.ts — the SAME
     * helper every other review agent (bug/security/performance/generalist)
     * uses to localize its output. When set, both the file-shard and
     * PR-shard user prompts get an explicit "respond in this language"
     * instruction; the shard's `suggestionContent`/WHAT-WHY-HOW body is
     * otherwise LLM-generated raw English with no downstream translation
     * guarantee for PR-scope findings (see kody-rules-agent.provider.ts).
     * Optional and backward compatible: omitting it (evals, older callers,
     * unit tests) leaves the shard prompts byte-identical to before this
     * field existed.
     */
    languageLabel?: string | null;
    /**
     * Where each compiled T0 detector fired (issue #1831). Two effects:
     *
     *   1. ROUTING — a rule that carries a detector is judged ONLY in the files
     *      its regex hit. A precise detector therefore still costs almost
     *      nothing (most files never reach a model), while a noisy one costs in
     *      proportion to its noise.
     *   2. HINTING — the hit lines are shown to the judge as candidates to
     *      confirm or reject, so recall does not rest on the model
     *      independently rediscovering what the regex already found.
     *
     * Absent = no detector rules in this review; every rule shards by `path`
     * exactly as before.
     */
    detectorHits?: DetectorHitIndex;
    /**
     * Repository slices retrieved for each file because one of its rules
     * declared it needs more than the hunk (issue #1826), keyed by filename the
     * same way `detectorHits` is keyed by rule.
     *
     * Absent = no rule in this review asked for context; every shard prompt is
     * byte-identical to before this existed.
     */
    contextSlices?: Map<string, RetrievedSlice[]>;
    /**
     * Per file, the uuids of the rules whose declared context need could NOT
     * be retrieved (issue #1826). Those rules are not sharded for that file at
     * all: a rule that said the hunk is not enough, judged on the hunk anyway,
     * is exactly the blind judgment this feature removes. The caller reports
     * them on the PR — a skipped rule must never look like a satisfied one.
     */
    unmetRules?: Map<string, Set<string>>;
    /**
     * The full text of each changed file, keyed by filename (issue #1826,
     * step 1). Unconditional: it is not gated on a rule declaring anything,
     * because "the rest of this file" is what the largest class of broken rule
     * needs and the shard is already per-file.
     *
     * Absent, or absent for one file, degrades to exactly today's hunk-only
     * prompt for that shard.
     */
    fileContents?: Map<string, string>;
}

export interface ShardedJudgeResult {
    violations: ShardViolation[];
    shardsRun: number;
    shardsErrored: number;
}

// ── prompts (aligned with the validated batched eval prompt) ─────────────────

export const SHARD_SYSTEM_PROMPT = `You check a set of team rules against the diff of a SINGLE file. Report EVERY added line that violates ANY of the listed rules — one entry per (rule, violating line).

Rules of engagement:
- Only flag lines ADDED in this diff (each line is prefixed with its file line number then '+'). Unchanged context lines are NEVER flagged.
- One entry PER violating line PER rule; do not collapse repeats. Downstream dedup folds repeats into one comment.
- Identify the violated rule by its number — the [n] shown before each rule. Put that number in "ruleId". Never invent a number; if a real issue matches no listed rule, DROP it.
- If nothing violates, return an empty list.`;

export const SHARD_PR_SYSTEM_PROMPT = `You evaluate PULL-REQUEST-level team rules against a PR: its title, description, the list of changed files, and the FULL DIFF of every changed file. Judge the PR as a whole — cross-file conditions (e.g. "one migration = one logical change", "index added to a table that already existed before this PR") are exactly what these rules are about, so reason across the whole diff. Identify each violated rule by its number — the [n] shown before each rule — and put that number in "ruleId"; never invent one. Return only real violations.`;

function ruleBlock(rules: Array<Partial<IKodyRule>>): string {
    return rules
        .map((r, i) => {
            const parts = [
                `[${i + 1}] ${r.title}`,
                `  description: ${r.rule}`,
            ];
            if (r.examples?.length) {
                parts.push(`  examples:`);
                for (const ex of r.examples) {
                    const label = ex.isCorrect ? 'correct' : 'incorrect';
                    parts.push(`    - ${label}: ${JSON.stringify(ex.snippet)}`);
                }
            }
            return parts.join('\n');
        })
        .join('\n');
}

/**
 * Extra user-prompt lines instructing the model to answer in `languageLabel`
 * (a resolved label like "Portuguese (Brazil)", not a raw locale code). Both
 * shard prompts have zero language templating on their own (the root cause
 * of the Starian GitLab MR !16111 bug: a PR-scope kody-rules comment shipped
 * in raw English despite the org's Kody Language being pt-BR), so this is
 * the ONLY place a language instruction enters either shard's prompt.
 * Returns `[]` when no label is given, so callers that splice this in with
 * `...languageInstructionLines(x)` produce a BYTE-IDENTICAL prompt to before
 * this existed whenever `languageLabel` is absent — no regression for evals
 * or other callers that don't pass one.
 */
function languageInstructionLines(languageLabel?: string | null): string[] {
    if (!languageLabel) return [];
    return [
        `Respond in ${languageLabel}: write "suggestionContent" and "oneSentenceSummary" in ${languageLabel}, not English. This is mandatory — do not fall back to English.`,
        ``,
    ];
}

/**
 * The candidate block for a file shard (issue #1831): the lines a compiled
 * regex detector already flagged, presented as questions rather than findings.
 *
 * The wording is the load-bearing part. Handing a model a list of pre-flagged
 * lines invites it to rubber-stamp them, which would reproduce the very bug
 * this replaces — so the block states plainly what the pre-filter is blind to
 * (language, comments, embedded languages, heredocs) and names rejection as the
 * expected outcome, not a failure. Those are not hypotheticals: they are the
 * three shapes the incident's false positives actually took — a Ruby rule
 * firing on .tsx/.scss, on JavaScript embedded in .erb, and on SQL inside a
 * `<<~SQL` heredoc in a migration.
 *
 * Returns [] when this shard has no candidates, so a shard of purely semantic
 * rules keeps a byte-identical prompt to before this existed.
 */
function candidateLines(
    file: FileChange,
    rules: Array<Partial<IKodyRule>>,
    detectorHits?: DetectorHitIndex,
): string[] {
    if (!detectorHits?.size) return [];
    const entries: string[] = [];
    rules.forEach((r, i) => {
        if (!r.uuid) return;
        const lines = detectorHits.get(r.uuid)?.get(file.filename);
        if (lines?.length) entries.push(`- rule [${i + 1}] -> line(s) ${lines.join(', ')}`);
    });
    if (!entries.length) return [];
    return [
        `<Candidates>`,
        `A cheap regex pre-filter flagged these lines. It matches raw text one line at a time and knows NOTHING else — not the file's language, not whether the line is a comment, not whether it sits inside a string, a heredoc, or a block of another language embedded in this file.`,
        ...entries,
        `Treat every candidate as a QUESTION, not a finding. Report it only if that line genuinely violates that rule in THIS file, judged in its real language and context; otherwise say nothing about it. Rejecting candidates is the normal outcome and needs no explanation. Violations the pre-filter missed are still yours to report.`,
        `</Candidates>`,
        ``,
    ];
}

/**
 * The intent block for a file shard (issue #1826): the PR's title and
 * description.
 *
 * The PR-scope shard has always received these; the file shard — which is the
 * overwhelming majority of calls — never did, so it judged every rule without
 * knowing what the change was for and flagged the exact edit the PR set out to
 * make. External evidence puts intent context above code context for this
 * decision (ContextCRBench), and it costs a few hundred tokens with no lookup.
 *
 * Same 1,000-character bound `prShardUser` already applies, so the two shards
 * stay consistent, but the cut is MARKED here: an unmarked truncation invites
 * the model to reason about a sentence that was severed mid-clause.
 *
 * Returns [] when there is no title and no description, so a shard built
 * without intent keeps a byte-identical prompt to before this existed.
 */
const INTENT_BUDGET_CHARS = 1000;

function intentLines(prTitle?: string, prBody?: string): string[] {
    const title = prTitle?.trim() ?? '';
    const body = prBody?.trim() ?? '';
    if (!title && !body) return [];
    const description = !body
        ? '(empty)'
        : body.length > INTENT_BUDGET_CHARS
          ? `${body.slice(0, INTENT_BUDGET_CHARS)}\n… (description truncated at ${INTENT_BUDGET_CHARS} characters)`
          : body;
    return [
        `<PR title=${JSON.stringify(title)}>`,
        `Description: ${description}`,
        `</PR>`,
        `This is what the change is trying to do. Use it to judge whether the added lines break the rules above.`,
        ``,
    ];
}

/**
 * Upper bound on the file content sent with a file shard.
 *
 * Its job is to keep a generated artefact out of the prompt, NOT to ration
 * ordinary source. Measured over this repository's 4,332 source files: median
 * 3,438 chars, p90 15,991, p99 52,171, max 281,072 (a generated bundle). At
 * this cap 97.7% of files go whole; the rest fall back to exactly today's
 * hunk-only prompt. For comparison the PR-scope shard already spends up to
 * PR_SHARD_DIFF_BUDGET_CHARS on one call.
 */
export const FILE_CONTENT_BUDGET_CHARS = 40_000;

/**
 * Line ceiling on the read that feeds it. The char budget above is the real
 * gate; this only stops a pathological file being pulled across the sandbox
 * boundary in full before that gate can reject it.
 */
export const FILE_CONTENT_MAX_LINES = 4000;

/**
 * The changed file, whole (issue #1826, step 1).
 *
 * The shard sees one file's hunks plus about three lines of context, so a rule
 * whose truth lives elsewhere IN THE SAME FILE cannot be judged: an import used
 * twenty lines below the window reads as unused (#1724), a function's length is
 * unknowable from its first hunk, "every public class has a docstring" cannot
 * be checked. That is the largest class of rule the diff-only judge broke, and
 * the file is right there.
 *
 * This is unconditional and needs no classification: the shard is already
 * per-file, so the file is the natural unit, and sending it costs the median
 * file about 860 tokens. Nothing here is language-aware, which is the point —
 * a customer's rule may target any language, so the retrieval that serves it
 * must not recognise syntax.
 *
 * Two properties are load-bearing:
 *
 *   - The diff stays marked and stays the thing being judged. The block below
 *     says so explicitly, because showing a model the whole file invites it to
 *     comment on lines this PR never touched.
 *   - Over budget it is OMITTED, never truncated. The head of a file is its
 *     imports and declarations; the evidence that refutes "unused" lives
 *     further down, so half a file is the one slice that actively misleads.
 *
 * Returns [] when there is no content, so a shard without it keeps a
 * byte-identical prompt to before this existed.
 */
function fileContentLines(file: FileChange, content?: string): string[] {
    const text = content?.trim();
    if (!text || text.length > FILE_CONTENT_BUDGET_CHARS) return [];
    return [
        `<FileContent path="${file.filename}">`,
        `The complete file as it stands in the repository, for context only. Line numbers match the diff below.`,
        '```',
        text,
        '```',
        `Use this to decide whether the ADDED lines break the rules — for example whether a symbol the diff introduces is used elsewhere in this file. These lines are NOT part of this pull request: never report a violation whose evidence lies outside the diff hunks, however wrong those lines look.`,
        `</FileContent>`,
        ``,
    ];
}

/**
 * The retrieved-context block for a file shard (issue #1826): the repository
 * slices a rule declared it needs in order to be judged at all.
 *
 * Same hazard as `candidateLines`, in mirror image. Showing a model
 * occurrences of a symbol invites it to comment on THEM — and every one of
 * those lines sits outside the diff, where a comment cannot be acted on and
 * was never asked for. So the block does two things beyond carrying the text:
 * it says what the retrieval could not see, so absence is not read as proof
 * (KRC-30), and it forbids reporting a violation whose evidence lies outside
 * the hunks (KRC-18). Rejection is named as the normal outcome for the same
 * reason it is named in the candidate block.
 *
 * Returns [] when this file has no slices, so a shard of purely diff-only
 * rules keeps a byte-identical prompt to before this existed.
 */
function contextLines(
    file: FileChange,
    contextSlices?: Map<string, RetrievedSlice[]>,
): string[] {
    const slices = contextSlices?.get(file.filename);
    if (!slices?.length) return [];

    const rendered: string[] = [];
    for (const slice of slices) {
        rendered.push(
            `- ${slice.label}${slice.truncated ? ' (cut short at the context budget — there may be more)' : ''}:`,
        );
        rendered.push('```');
        rendered.push(slice.content);
        rendered.push('```');
    }

    // Two kinds of slice with OPPOSITE instructions, and getting this wrong
    // silences the rule it was retrieved for.
    //
    // A `symbol-references` or `sibling-file` slice is somebody ELSE's code:
    // the finding must not be about those lines, because a comment there
    // cannot be acted on in this PR.
    //
    // A `full-file` slice is the SAME scope the diff edits, and the rules that
    // ask for it are about a property of the whole — its length, a block
    // repeated inside it, an import used further down. For those the evidence
    // necessarily sits outside the hunk, so the blanket "never report a
    // violation whose evidence lies outside the diff" forbids exactly the
    // finding the rule exists to make. Measured: with that sentence alone the
    // "function is too long" case fired 1 time in 5 despite the whole file
    // being on the page.
    const hasWholeFile = slices.some((s) => s.kind === 'full-file');
    const hasExternal = slices.some((s) => s.kind !== 'full-file');

    const closing: string[] = [];
    if (hasWholeFile) {
        closing.push(
            `The file content above is the REST OF THE FILE this diff edits — the same functions and classes, not another author's code. A rule about a property of a whole function, class or file (how long it is, a block repeated inside it, whether something declared here is used further down) is judged against ALL of it, so the evidence for such a violation may well sit outside the hunk. When one holds, report it and anchor it on a line this PR ADDED. Do NOT raise separate findings about pre-existing lines the PR did not touch.`,
        );
    }
    if (hasExternal) {
        closing.push(
            `The repository slices above are NOT part of this pull request. Use them only to decide whether the lines ADDED in the diff break the rules. Never report a violation whose evidence lies in them, however wrong those lines look — they are not this PR's to fix.`,
        );
    }
    closing.push(
        `Concluding "no violation here" is the normal outcome and needs no explanation.`,
    );

    return [
        `<Context>`,
        `Slices of the repository retrieved by code, because one of the rules above says the hunk alone is not enough to judge it. Retrieval is deterministic and narrow: it followed only the paths and symbols this diff names. It cannot see dynamic or generated references, other branches, or the same thing under another name — so what is missing here is weak evidence, while what is present is reliable.`,
        ...rendered,
        ...closing,
        `</Context>`,
        ``,
    ];
}

function fileShardUser(
    file: FileChange,
    rules: Array<Partial<IKodyRule>>,
    languageLabel?: string | null,
    detectorHits?: DetectorHitIndex,
    prTitle?: string,
    prBody?: string,
    contextSlices?: Map<string, RetrievedSlice[]>,
    fileContents?: Map<string, string>,
): string {
    const diff = (file as any).patchWithLinesStr ?? file.patch ?? '';
    return [
        `<Rules>`,
        ruleBlock(rules),
        `</Rules>`,
        ``,
        ...intentLines(prTitle, prBody),
        // The whole file BEFORE the diff: the reader needs the world before
        // the change to it.
        ...fileContentLines(file, fileContents?.get(file.filename)),
        `<File path="${file.filename}">`,
        `Each diff line is prefixed with its file line number; '+' marks a line ADDED by this PR.`,
        '```diff',
        diff,
        '```',
        `</File>`,
        ``,
        // Context BEFORE candidates: the candidates are questions to be judged
        // using the context, so the evidence has to be on the page first.
        ...contextLines(file, contextSlices),
        ...candidateLines(file, rules, detectorHits),
        ...languageInstructionLines(languageLabel),
        // `improvedCode` and `language` are REQUIRED by the wire schema but were
        // missing from this template, so models filled them with null and every
        // sharded kody-rules finding shipped without a fix to apply and without
        // a language for the diff block. Issue #1831 requires a detector-derived
        // finding to carry an applicable `improvedCode`; since detector findings
        // now come through this same shard, asking for it here fixes the whole
        // stream at once. `existingCode` is called out explicitly because models
        // otherwise copy the line WITH its `<n> +` diff prefix.
        `Return ONLY JSON (ruleId is the rule's [n] number). "existingCode" is the offending code EXACTLY as it appears in the file — strip the line-number and '+' prefix the diff adds. "improvedCode" is that same code rewritten to satisfy the rule, ready to apply; use null only when the fix cannot be expressed as a replacement for those lines. "language" is the file's language (e.g. "ruby", "typescript").`,
        // The claim fields (issue #1826). You only see one file's hunks, so an
        // assertion about the rest of the repository is a guess; naming it
        // lets the pipeline check it against the real repository and drop the
        // finding when the repository says otherwise. Under-claiming is safe —
        // "none" publishes the finding unchanged, exactly as today.
        `State what your finding ASSERTS about the repository in "claimKind": "unused" (this symbol is used nowhere else), "missing" (this file or path does not exist), "duplicate" (this already exists elsewhere), or "none" for everything else. Name the target: "claimSymbol" is the identifier the claim is about, "claimPath" the file path; use null for whichever does not apply. A claim is CHECKED against the repository and the finding is dropped if the repository contradicts it, so claim only what you mean.`,
        `{"violations":[{"ruleId":<n>,"relevantLinesStart":<line>,"relevantLinesEnd":<line>,"language":"<lang>","existingCode":"<offending code>","improvedCode":"<fixed code or null>","suggestionContent":"WHAT/WHY/HOW","oneSentenceSummary":"<short>","claimKind":"<unused|missing|duplicate|none>","claimSymbol":"<symbol or null>","claimPath":"<path or null>"}]}`,
    ].join('\n');
}

/**
 * Total diff budget for the PR-scope shard. The shard originally sent only the
 * file NAME list — which blinded every content-dependent PR-scope rule (the
 * migration-safety rule missed 100% across all models: the model literally
 * could not see `add_index` vs `create_table`). The old agentic path saw the
 * full patches, so metadata-only was a regression of the sharded refactor.
 * The budget keeps a runaway PR from blowing the context window; files beyond
 * it degrade to name-only with an explicit marker (never silently).
 */
const PR_SHARD_DIFF_BUDGET_CHARS = 150_000;

function prShardUser(
    files: FileChange[],
    rules: Array<Partial<IKodyRule>>,
    prTitle?: string,
    prBody?: string,
    languageLabel?: string | null,
): string {
    let used = 0;
    const diffs: string[] = [];
    for (const f of files) {
        const raw = (f as any).patchWithLinesStr ?? f.patch;
        const diff = raw ? String(raw) : '';
        if (!diff) {
            diffs.push(`## file: '${f.filename}' (no diff available)`);
            continue;
        }
        if (used + diff.length > PR_SHARD_DIFF_BUDGET_CHARS) {
            diffs.push(
                `## file: '${f.filename}' (diff omitted — PR diff budget exceeded)`,
            );
            continue;
        }
        used += diff.length;
        diffs.push(diff);
    }
    return [
        `<Rules>`,
        ruleBlock(rules),
        `</Rules>`,
        ``,
        `<PR title=${JSON.stringify(prTitle || '')}>`,
        `Description: ${prBody ? prBody.slice(0, 1000) : '(empty)'}`,
        `Changed files (${files.length}):`,
        ...files.map((f) => `- ${f.filename}`),
        ``,
        `Full diff of every changed file (each line prefixed with its file line number; '+' marks a line ADDED by this PR):`,
        '```diff',
        ...diffs,
        '```',
        `</PR>`,
        ``,
        ...languageInstructionLines(languageLabel),
        `Return ONLY JSON (ruleId is the rule's [n] number): {"violations":[{"ruleId":<n>,"suggestionContent":"WHAT/WHY","oneSentenceSummary":"<short>"}]}`,
    ].join('\n');
}

export function ruleAppliesToFile(filePath: string, pattern?: string): boolean {
    if (!pattern) return true;
    // Shared helper: rule paths may be several comma-joined globs — see
    // fileMatchesRulePath for why matching the joined string is a bug.
    return fileMatchesRulePath(filePath, pattern);
}

function matchesPathPattern(filePath: string, pattern: string): boolean {
    return ruleAppliesToFile(filePath, pattern);
}

function rulesForFile(
    file: FileChange,
    rules: Array<Partial<IKodyRule>>,
    detectorHits?: DetectorHitIndex,
    unmetRules?: Map<string, Set<string>>,
): Array<Partial<IKodyRule>> {
    return rules.filter((r) => {
        if (r.path && !matchesPathPattern(file.filename, r.path)) return false;
        // The rule's OWN language scope (issue #1826). A Ruby rule stops being
        // sharded against .tsx files — which until now it was, for every one of
        // the 92,5% of rules that carry no detector, because the scope only
        // existed inside the detector plan. Cheapest clause, so it runs first
        // after the author's glob; the author's `path` still outranks it, since
        // `path` is stated and this is inferred.
        if (!extensionScopeAppliesToFile(file.filename, r.fileScope?.extensions))
            return false;
        // A rule whose declared context need could not be retrieved for this
        // file is not judged here. Sits before the detector clause so it holds
        // for mechanical rules too — a detector hit is a candidate line, not
        // the context the rule said it needs to judge it.
        if (r.uuid && unmetRules?.get(file.filename)?.has(r.uuid)) return false;
        // A rule carrying a compiled detector is judged only where the detector
        // fired. Without this the T0 pre-filter would buy nothing — a mechanical
        // rule would shard every file, exactly like a semantic one.
        if (r.detector && r.uuid) {
            return !!detectorHits?.get(r.uuid)?.has(file.filename);
        }
        return true;
    });
}

/**
 * Say out loud which rules this PR never judged.
 *
 * Every narrowing clause in `rulesForFile` — the author's glob, the inferred
 * language scope, an unmet context need, a detector that fired nowhere — makes
 * a rule cheaper by making it INVISIBLE. When the narrowing is right that is
 * the whole point; when it is wrong the rule is simply never enforced and
 * nothing anywhere says so. That silence is the failure mode: a customer whose
 * Ruby rule is scoped to the wrong extension sees no comment and no error, and
 * reads it as "Kody agrees with my code".
 *
 * One aggregated line per review, not one per rule: this is a diagnostic for
 * us, and a per-rule log on a 200-file PR would bury it.
 */
function reportUnjudgedFileRules(
    fileRules: Array<Partial<IKodyRule>>,
    shards: Array<{ applicable: Array<Partial<IKodyRule>> }>,
    logger?: ShardedJudgeInput['logger'],
): void {
    if (!logger || fileRules.length === 0) return;
    const judged = new Set<string>();
    for (const shard of shards) {
        for (const rule of shard.applicable) {
            if (rule.uuid) judged.add(rule.uuid);
        }
    }
    const unjudged = fileRules.filter((r) => r.uuid && !judged.has(r.uuid));
    if (unjudged.length === 0) return;
    logger.warn({
        message: `[kody-rules-shard] ${unjudged.length} of ${fileRules.length} file-scope rule(s) matched no changed file and were not judged`,
        // SimpleLogger drops entries without a context string.
        context: 'kody-rules-sharded',
        metadata: {
            rules: unjudged.map((r) => ({
                uuid: r.uuid,
                title: r.title,
                path: r.path,
                extensions: r.fileScope?.extensions,
                hasDetector: !!r.detector,
            })),
        },
    });
}

const isPrLevel = (r: Partial<IKodyRule>) =>
    r.scope === KodyRulesScope.PULL_REQUEST;

async function mapLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const out = new Array<R>(items.length);
    let i = 0;
    await Promise.all(
        Array.from(
            { length: Math.min(Math.max(1, limit), items.length || 1) },
            async () => {
                while (i < items.length) {
                    const idx = i++;
                    out[idx] = await fn(items[idx]);
                }
            },
        ),
    );
    return out;
}

/**
 * T2 reference-inline (pure): for each rule that points at a repo file
 * (`sourcePath`), fetch that file via the injected `read` and append its
 * content to the rule text so the judge sees the full convention. Deterministic
 * (code follows `sourcePath`; the model never decides what to open). Missing
 * file / read error / no sandbox all degrade to the rule text alone — never
 * worse than not having the reference. Extracted here (not on the provider) so
 * it is unit-testable without the provider's heavy import graph.
 *
 * NOTE: this handles `sourcePath` only (the rule's own source file, IDE-sync /
 * centralized-config). The `@file:` citations authors write in the rule BODY
 * are resolved through the Context OS (`contextReferenceId`) — see
 * `inlineLoadedReferences`.
 */
export async function inlineRuleReferences(
    rules: Array<Partial<IKodyRule>>,
    read:
        | ((path: string, start: number, end: number) => Promise<string>)
        | undefined,
    logger?: { warn: (entry: any) => void },
    maxRefChars = 6000,
): Promise<Array<Partial<IKodyRule>>> {
    if (!read) return rules;
    return Promise.all(
        rules.map(async (rule) => {
            const sourcePath = rule.sourcePath?.trim();
            if (!sourcePath) return rule;
            try {
                const content = await read(sourcePath, 1, 100000);
                if (!content || content.trim().length === 0) return rule;
                const anchor = rule.sourceAnchor
                    ? ` (section: ${rule.sourceAnchor})`
                    : '';
                return {
                    ...rule,
                    rule: `${rule.rule}\n\n[Authoritative convention referenced by this rule — from \`${sourcePath}\`${anchor}]:\n${content.slice(0, maxRefChars)}`,
                };
            } catch (err) {
                logger?.warn({
                    message: `kody-rules reference load failed for ${sourcePath} (rule ${rule.uuid}); judging without it`,
                    // context required or SimpleLogger.shouldSkipLog drops it
                    context: 'kody-rules-sharded',
                    metadata: { ruleUuid: rule.uuid, sourcePath, err },
                });
                return rule;
            }
        }),
    );
}

/** One resolved reference from the Context OS (shape from `LoadedReference`). */
export interface LoadedRuleReference {
    filePath?: string;
    content?: string;
    description?: string;
}

/**
 * Inline references resolved from the Context OS into the rule text. Pure.
 *
 * `referencesMap` (rule uuid -> resolved references WITH content) comes from
 * `ExternalReferenceLoaderService.loadReferencesForRules` — the SAME resolver
 * the PR-level path uses — which follows each rule's `contextReferenceId` and
 * fetches the file content (same or cross repo, via `getRepositoryContentFile`).
 *
 * This is the current-architecture path: `@file:` citations are stored as a
 * `contextReferenceId` on the rule ("context-os-only"), NOT as an inline
 * `externalReferences` array, and the code-review path reads rules raw (no UI
 * enrichment). So the sharded judge saw the bare "@file:X" marker and judged
 * blind — the root cause of the recall miss. With the loaded content appended,
 * the judge sees the authoritative convention instead of the marker.
 *
 * Empty/absent map entries and empty content degrade to the rule text alone.
 * `maxRefChars` bounds the TOTAL appended text PER RULE (not per reference) —
 * the augmented rule is re-embedded in every shard, so the budget caps the
 * token multiplication across changed files.
 */
export function inlineLoadedReferences(
    rules: Array<Partial<IKodyRule>>,
    referencesMap: Map<string, LoadedRuleReference[]> | undefined,
    logger?: { warn: (entry: any) => void; log?: (entry: any) => void },
    maxRefChars = 6000,
): Array<Partial<IKodyRule>> {
    if (!referencesMap || referencesMap.size === 0) return rules;
    return rules.map((rule) => {
        const refs = rule.uuid ? referencesMap.get(rule.uuid) : undefined;
        if (!refs || refs.length === 0) return rule;

        let augmented = rule.rule ?? '';
        const baseLen = (rule.rule ?? '').length;
        const inlined: string[] = [];
        for (const ref of refs) {
            const content = ref?.content;
            if (!content || content.trim().length === 0) continue;
            // Per-rule TOTAL budget, not per-ref: this augmented text is
            // re-embedded into EVERY file shard's rule block (and the PR shard's,
            // which only budgets diffs), so an unbounded rule multiplies the LLM
            // input by the changed-file count and can overflow the context /
            // fail every shard. Stop once the appended text hits maxRefChars.
            const remaining = maxRefChars - (augmented.length - baseLen);
            if (remaining <= 0) break;
            const filePath = ref?.filePath?.trim() || 'referenced file';
            augmented += `\n\n[Authoritative convention referenced by this rule — from \`${filePath}\`]:\n${content.slice(0, remaining)}`;
            inlined.push(filePath);
        }
        if (inlined.length === 0) return rule;

        // Success is otherwise silent; log it so a reference actually reaching
        // the shard prompt is visible in the worker logs.
        logger?.log?.({
            message: `[kody-rules-shard] inlined ${inlined.length} reference file(s) for rule ${rule.uuid}: ${inlined.join(', ')}`,
            context: 'kody-rules-sharded',
            metadata: {
                ruleUuid: rule.uuid,
                ruleTitle: rule.title,
                inlinedRefs: inlined,
                addedChars: augmented.length - (rule.rule ?? '').length,
            },
        });
        return { ...rule, rule: augmented };
    });
}

/**
 * Rules that declare a `contextReferenceId` but for which the loader resolved
 * nothing usable — the file citation failed to resolve (fetch error, missing
 * branch, a reference that no longer exists) OR resolved only empty/whitespace
 * content. The judge runs these WITHOUT their referenced file, so callers
 * should surface it: otherwise the judge-blind degradation is silent, since
 * `inlineLoadedReferences` logs only on success.
 *
 * "Resolved" here MUST match what `inlineLoadedReferences` actually inlines
 * (`content.trim()` non-empty) — a map entry can exist yet hold only whitespace
 * (a whitespace-only reference file passes the loader's `typeof === 'string'`
 * guard), which inlines nothing. Checking only `map.has(uuid)` would miss that.
 */
export function findUnresolvedReferenceRules(
    rules: Array<Partial<IKodyRule>>,
    referencesMap: Map<string, LoadedRuleReference[]> | undefined,
): Array<Partial<IKodyRule>> {
    return rules.filter((r) => {
        if (!r.contextReferenceId) return false;
        const refs = r.uuid ? referencesMap?.get(r.uuid) : undefined;
        return !refs || refs.every((ref) => !ref?.content?.trim());
    });
}

/**
 * Resolve a model-emitted `ruleId` to a real rule UUID, or null to drop it.
 *
 * Primary path (#1170): `ruleId` is the rule's 1-based index in this shard's
 * ordered list, so a corruptible 36-char UUID never enters the round-trip. An
 * out-of-range index is a hallucination → drop.
 *
 * Fallback: if the model reverts to echoing a UUID string, accept an exact
 * match or recover a lightly-corrupted one (edit distance ≤ 2 to exactly one
 * shard rule); ambiguous or far ids are dropped.
 */
function resolveRuleId(
    ruleId: unknown,
    orderedUuids: string[],
    known: Set<string>,
): string | null {
    // `ruleId` is untrusted LLM output — the eval harness parses raw model JSON
    // without the zod schema, so a missing field or an echoed old `ruleUuid`
    // key arrives here as undefined/null/non-scalar. Drop just that entry
    // rather than throwing (which the per-shard try/catch would escalate into
    // discarding every real violation for the file).
    if (typeof ruleId !== 'number' && typeof ruleId !== 'string') {
        return null;
    }

    const asIndex =
        typeof ruleId === 'number'
            ? ruleId
            : /^\d+$/.test(ruleId.trim())
              ? Number(ruleId.trim())
              : NaN;

    if (Number.isInteger(asIndex)) {
        if (asIndex >= 1 && asIndex <= orderedUuids.length) {
            return orderedUuids[asIndex - 1] || null;
        }
        return null;
    }

    const echoed = String(ruleId).trim();
    if (known.has(echoed)) {
        return echoed;
    }
    return recoverRuleUuid(echoed, known);
}

/**
 * Resolve each raw violation's `ruleId` to a real UUID, dropping the ones that
 * don't map to a rule in this shard. `orderedUuids` is index-aligned with the
 * rules as presented to the model.
 */
function resolveShardViolations(
    vs: RawShardViolation[],
    orderedUuids: string[],
): ShardViolation[] {
    const known = new Set(orderedUuids.filter(Boolean));
    const kept: ShardViolation[] = [];
    for (const v of vs) {
        const ruleUuid = resolveRuleId(v.ruleId, orderedUuids, known);
        if (!ruleUuid) {
            continue;
        }
        const { ruleId: _ruleId, ...rest } = v;
        // Strict-schema providers emit `null` for required-but-inapplicable
        // keys; downstream (line snapping, mapping) expects them absent.
        const normalized = Object.fromEntries(
            Object.entries(rest).filter(([, value]) => value !== null),
        ) as Omit<RawShardViolation, 'ruleId'>;
        kept.push({ ...normalized, ruleUuid });
    }
    return kept;
}

/**
 * Run the deterministic file×rule sweep. File-scope rules → one call per file
 * with its applicable rules; PR-scope rules → one whole-PR call. Returns all
 * violations with their ruleUuid preserved (downstream mapping fills
 * brokenKodyRulesIds and reconciles the uuid).
 */
export async function judgeKodyRulesSharded(
    input: ShardedJudgeInput,
): Promise<ShardedJudgeResult> {
    const {
        changedFiles,
        rules,
        runJudge,
        prTitle,
        prBody,
        logger,
        languageLabel,
        detectorHits,
        contextSlices,
        unmetRules,
        fileContents,
    } = input;
    const concurrency = input.concurrency ?? SHARD_CONCURRENCY_DEFAULT;

    // A rule whose detector fired NOWHERE in this PR is not judged at all —
    // that is the entire cost saving of the T0 pre-filter (issue #1831), and it
    // covers PR-scope detector rules too, which `rulesForFile` never sees.
    const judgeable = rules.filter(
        (r) => !r.detector || !r.uuid || !!detectorHits?.get(r.uuid)?.size,
    );

    const fileRules = judgeable.filter((r) => !isPrLevel(r));
    const prRules = judgeable.filter(isPrLevel);

    let shardsRun = 0;
    let shardsErrored = 0;
    const violations: ShardViolation[] = [];

    // ── file-scope shards: one per changed file that has applicable rules ────
    const fileShards = changedFiles
        .map((file) => ({
            file,
            applicable: rulesForFile(file, fileRules, detectorHits, unmetRules),
        }))
        .filter((s) => s.applicable.length > 0);

    reportUnjudgedFileRules(fileRules, fileShards, logger);

    const perFile = await mapLimit(
        fileShards,
        concurrency,
        async ({ file, applicable }) => {
            shardsRun++;
            // Index-aligned with the rules `ruleBlock` presents (a ruleId of N
            // maps to applicable[N-1]); keep '' holes rather than filtering so
            // the indices don't shift.
            const ruleUuids = applicable.map((r) => r.uuid ?? '');
            try {
                const vs = await runJudge({
                    system: SHARD_SYSTEM_PROMPT,
                    user: fileShardUser(
                        file,
                        applicable,
                        languageLabel,
                        detectorHits,
                        prTitle,
                        prBody,
                        contextSlices,
                        fileContents,
                    ),
                    filename: file.filename,
                    ruleUuids,
                });
                // resolve ruleId→uuid (dropping hallucinated indices), then
                // anchor every violation to this file
                return resolveShardViolations(vs, ruleUuids).map((v) => ({
                    ...v,
                    relevantFile: file.filename,
                }));
            } catch (err) {
                shardsErrored++;
                logger?.warn({
                    message: `[kody-rules-shard] file shard failed for ${file.filename} (${applicable.length} rule(s)) — degrading to zero findings: ${err instanceof Error ? err.message : String(err)}`,
                    // SimpleLogger silently drops entries without a context
                    // string (shouldSkipLog) — omitting it would re-swallow
                    // exactly the failure this log exists to surface.
                    context: 'kody-rules-sharded',
                    metadata: { filename: file.filename, err },
                });
                return [] as ShardViolation[];
            }
        },
    );
    for (const vs of perFile) violations.push(...vs);

    // ── PR-scope shard: one call over the whole PR ──────────────────────────
    if (prRules.length > 0) {
        shardsRun++;
        const ruleUuids = prRules.map((r) => r.uuid ?? '');
        try {
            const vs = await runJudge({
                system: SHARD_PR_SYSTEM_PROMPT,
                user: prShardUser(
                    changedFiles,
                    prRules,
                    prTitle,
                    prBody,
                    languageLabel,
                ),
                filename: null,
                ruleUuids,
            });
            // PR-level violations carry no relevantFile by design
            for (const v of resolveShardViolations(vs, ruleUuids))
                violations.push(v);
        } catch (err) {
            shardsErrored++;
            logger?.warn({
                message: `[kody-rules-shard] PR-scope shard failed (${prRules.length} rule(s)) — degrading to zero findings: ${err instanceof Error ? err.message : String(err)}`,
                context: 'kody-rules-sharded',
                metadata: { err },
            });
        }
    }

    return { violations, shardsRun, shardsErrored };
}
