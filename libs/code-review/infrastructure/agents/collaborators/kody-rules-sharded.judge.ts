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
import {
    createReviewContextDelivery,
    formatReviewContext,
    type ReviewContext,
    type ReviewContextDelivery,
} from '@libs/cli-review/domain/types/review-context.types';
import { jsonSchema, type Schema } from 'ai';
import { z } from 'zod';
import { recoverRuleUuid } from './finding-mapper';
import { fileMatchesRulePath } from '@libs/common/utils/kody-rules/file-patterns';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    IKodyRule,
    KodyRulesScope,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

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

export interface ShardedJudgeInput {
    changedFiles: FileChange[];
    /** active, non-memory STANDARD rules already resolved for this review. */
    rules: Array<Partial<IKodyRule>>;
    runJudge: RunJudge;
    reviewContext?: ReviewContext;
    prTitle?: string;
    prBody?: string;
    /** max concurrent shard calls (BYOK models rate-limit — keep modest). */
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
}

export interface ShardedJudgeResult {
    violations: ShardViolation[];
    shardsRun: number;
    shardsErrored: number;
    reviewContextDeliveries?: ReviewContextDelivery[];
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
            const parts = [`[${i + 1}] ${r.title}`, `  description: ${r.rule}`];
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

function fileShardUser(
    file: FileChange,
    rules: Array<Partial<IKodyRule>>,
    languageLabel?: string | null,
    reviewContext?: ReviewContext,
): string {
    const diff = (file as any).patchWithLinesStr ?? file.patch ?? '';
    const prompt = [
        `<Rules>`,
        ruleBlock(rules),
        `</Rules>`,
        ``,
        `<File path="${file.filename}">`,
        `Each diff line is prefixed with its file line number; '+' marks a line ADDED by this PR.`,
        '```diff',
        diff,
        '```',
        `</File>`,
        ``,
        ...languageInstructionLines(languageLabel),
        `Return ONLY JSON (ruleId is the rule's [n] number):`,
        `{"violations":[{"ruleId":<n>,"relevantLinesStart":<line>,"relevantLinesEnd":<line>,"existingCode":"<offending code>","suggestionContent":"WHAT/WHY/HOW","oneSentenceSummary":"<short>"}]}`,
    ].join('\n');
    const contextBlock = formatReviewContext(reviewContext);
    return contextBlock ? `${contextBlock}\n\n${prompt}` : prompt;
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
    reviewContext?: ReviewContext,
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
    const prompt = [
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
    const contextBlock = formatReviewContext(reviewContext);
    return contextBlock ? `${contextBlock}\n\n${prompt}` : prompt;
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
): Array<Partial<IKodyRule>> {
    return rules.filter(
        (r) => !r.path || matchesPathPattern(file.filename, r.path),
    );
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
        reviewContext,
        prTitle,
        prBody,
        logger,
        languageLabel,
    } = input;
    const concurrency = input.concurrency ?? 4;
    const safeContextFailureMetadata = (
        err: unknown,
        metadata: Readonly<Record<string, unknown>> = {},
    ): Readonly<Record<string, unknown>> => {
        const source =
            typeof err === 'object' && err !== null
                ? (err as Record<string, unknown>)
                : {};
        const errorName =
            typeof source.name === 'string' &&
            /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(source.name)
                ? source.name
                : 'Error';
        const errorCode =
            typeof source.code === 'string' &&
            /^[A-Za-z0-9_.-]{1,64}$/u.test(source.code)
                ? source.code
                : undefined;
        return {
            ...metadata,
            reason: 'Provider call failed while processing request-scoped context',
            errorName,
            ...(errorCode ? { errorCode } : {}),
        };
    };

    const fileRules = rules.filter((r) => !isPrLevel(r));
    const prRules = rules.filter(isPrLevel);

    let shardsRun = 0;
    let shardsErrored = 0;
    const violations: ShardViolation[] = [];
    const reviewContextDeliveries: ReviewContextDelivery[] = [];

    // ── file-scope shards: one per changed file that has applicable rules ────
    const fileShards = changedFiles
        .map((file) => ({ file, applicable: rulesForFile(file, fileRules) }))
        .filter((s) => s.applicable.length > 0);

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
                if (reviewContext) {
                    reviewContextDeliveries.push(
                        createReviewContextDelivery(
                            reviewContext,
                            `kodus-rules-review-agent:${file.filename}`,
                            'file-shard',
                        ),
                    );
                }
                const vs = await runJudge({
                    system: SHARD_SYSTEM_PROMPT,
                    user: fileShardUser(
                        file,
                        applicable,
                        languageLabel,
                        reviewContext,
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
                    message: `[kody-rules-shard] file shard failed for ${file.filename} (${applicable.length} rule(s)) — degrading to zero findings${reviewContext ? '' : `: ${err instanceof Error ? err.message : String(err)}`}`,
                    // SimpleLogger silently drops entries without a context
                    // string (shouldSkipLog) — omitting it would re-swallow
                    // exactly the failure this log exists to surface.
                    context: 'kody-rules-sharded',
                    metadata: reviewContext
                        ? safeContextFailureMetadata(err, {
                              filename: file.filename,
                          })
                        : { filename: file.filename, err },
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
            if (reviewContext) {
                reviewContextDeliveries.push(
                    createReviewContextDelivery(
                        reviewContext,
                        'kodus-rules-review-agent:pull-request',
                        'pr-shard',
                    ),
                );
            }
            const vs = await runJudge({
                system: SHARD_PR_SYSTEM_PROMPT,
                user: prShardUser(
                    changedFiles,
                    prRules,
                    prTitle,
                    prBody,
                    languageLabel,
                    reviewContext,
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
                message: `[kody-rules-shard] PR-scope shard failed (${prRules.length} rule(s)) — degrading to zero findings${reviewContext ? '' : `: ${err instanceof Error ? err.message : String(err)}`}`,
                context: 'kody-rules-sharded',
                metadata: reviewContext
                    ? safeContextFailureMetadata(err)
                    : { err },
            });
        }
    }

    return {
        violations,
        shardsRun,
        shardsErrored,
        ...(reviewContextDeliveries.length > 0 && {
            reviewContextDeliveries,
        }),
    };
}
