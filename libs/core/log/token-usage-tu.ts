/**
 * Token Usage — write-time `tu` derivation (perf, zero logic change).
 *
 * The Token Usage screen aggregates over `observability_telemetry`. The token
 * values live as *dotted-key* attributes (`attributes["gen_ai.usage.*"]`) which
 * Mongo can't index → the aggregation FETCHes ~1.9M fat docs (~92s → 504).
 *
 * Fix: mirror the same values into an *indexable nested* sub-doc `attributes.tu`
 * so the read aggregation is index-covered (docsExamined=0, ~2s). `tu` is a PURE
 * function of the very attributes the old pipeline already reads off the same
 * span — so the numbers are identical, it only swaps "scan fat doc" for "read
 * from index".
 *
 * It MUST live under `attributes.*` (not top-level): the @kodus/flow MongoDB
 * exporter owns the top-level doc shape and only persists what the app sets via
 * `span.setAttributes(...)`. A nested object there survives `deepSanitize`
 * untouched (it only redacts sensitive keys), so `attributes.tu.model` is a real
 * indexable path — not a flattened dotted key.
 */

/**
 * Canonical shape mirrored onto every LLM-usage span. `isByok` / `sys` encode
 * the two Token Usage views WITHOUT changing their logic:
 *   - byok=true  view → spans with `isByok === true` (attributes.type === 'byok')
 *   - byok=false view → spans with `sys === false` (i.e. NOT one of the internal
 *     system-analysis run-names — the "would-be billable" cost simulation)
 * These are two independent predicates over `type` vs `run.name`, so both flags
 * are carried; collapsing them (e.g. `type !== 'byok'`) would change the numbers.
 */
export interface TokenUsageTu {
    isByok: boolean;
    sys: boolean;
    model: string;
    /** BYOK credential the spend attributes to — the per-key dimension the store
     *  otherwise lacked (spend rolled up by model-NAME, which breaks on versioned
     *  response names). `''` for env/managed/legacy usage → falls back to the
     *  name-based rollup. Mirrored by backfill-tu.ts (asserted equal by the spec). */
    credentialId: string;
    input: number;
    output: number;
    total: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    /** Process area the tokens were spent in — see {@link deriveArea}. This is
     *  the PROCESS axis (where in the pipeline: review/suggestions/summary/…),
     *  derived from the run name. Distinct from {@link route}. */
    area: TokenUsageArea;
    /** Routing TASK the call served (`codeReview`/`prSummary`/`kodyRulesReview`/
     *  `businessValidation`), stamped on the span by the router. This is the
     *  CONFIG axis (which model-slot you picked per task) — the dimension the
     *  per-task spend view groups by. `''` when the call was not task-routed
     *  (env/managed default, or a direct-slot call). Distinct from {@link area}:
     *  one task (e.g. `codeReview`) fans out across several areas (review +
     *  suggestions), so they answer different questions. */
    route: string;
}

/**
 * Low-cardinality "where was this token spent" dimension for the Token Usage
 * screen. A small FIXED set — never store raw `gen_ai.run.name` / `agent.name`
 * here (hundreds of values, some dynamic per-file/per-skill).
 */
export type TokenUsageArea =
    | 'review' // generalist code-review agents (incl. verify/dedup)
    | 'kody_rules' // kody-rules analysis, generation and sync
    | 'suggestions' // suggestion refinement (severity/safeguard/validation)
    | 'summary' // PR summary generation
    | 'conversation' // @kody conversation
    | 'system' // internal system analysis (SYSTEM_RUN_NAMES)
    | 'other';

/**
 * Exact run-names of the suggestion-refinement stages. Kept as a list (not a
 * regex) so the Mongo backfill can mirror it with a plain `$in` — the backfill
 * in libs/core/infrastructure/database/mongo/token-usage/backfill-tu.ts keeps
 * a copy, asserted equal by token-usage-tu.spec.ts.
 */
export const SUGGESTION_RUN_NAMES: ReadonlySet<string> = new Set([
    // Current run-names (classify-severity.ts / format-suggestion-content.ts).
    // Without these the suggestion-refinement spend leaked into `other` — the
    // "Other" bucket on the Token Usage screen was really mislabeled suggestions.
    'severity-classifier',
    'suggestion-formatter',
    // Legacy names kept so historical spans still bucket correctly.
    'severityAnalysis',
    'validateWithLLM',
    'checkSuggestionSimplicity',
    'repeatedCodeReviewSuggestionClustering',
]);

/**
 * Internal analysis operations excluded from the byok=false ("would-be
 * billable") view. Kept in sync with `LLMAnalysisService` method names — the
 * read path historically referenced `LLMAnalysisService.prototype.*.name`, but
 * this low-level core module cannot import from `code-review`, so the literals
 * are pinned here and asserted against the real method names by a unit test in
 * the code-review package.
 */
export const SYSTEM_RUN_NAMES: ReadonlySet<string> = new Set([
    'selectReviewMode',
    'validateImplementedSuggestions',
    'generateCodeSuggestions',
]);

const n = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * Maps a span's run/agent identifiers onto the fixed {@link TokenUsageArea}
 * set. Driven by `gen_ai.run.name` — the one attribute every usage span
 * carries (the LangChain path sets no `agent.name`/`agent.phase`). Rule order
 * matters: system first (consistent with the `sys` flag), then the most
 * specific name families. Mirrored as an aggregation `$switch` in the Mongo
 * backfill (backfill-tu.ts) — keep the two in sync.
 */
export function deriveArea(
    runName: unknown,
    phase?: unknown,
): TokenUsageArea {
    const rn = typeof runName === 'string' ? runName : '';

    if (SYSTEM_RUN_NAMES.has(rn)) return 'system';
    // kodyRulesAnalyzeCodeWithAI, generateKodyRules.*, prLevelKodyRules*,
    // *KodyRulesAnalyzeCodeWithAI, kodyRulesFileToRules*, kodyMemoryResolution…
    // `kod(y|us)` — the review AGENT run-name is `kodus-rules-review-agent`
    // (product is "Kodus"), while the analysis/generation run-names use `kody`
    // (`kodyRulesAnalyzeCodeWithAI`). Match BOTH, or the kody-rules review agent
    // falls through to `other` and shows up as "Unrouted" in the per-task view.
    if (/kod(?:y|us).?rules?/i.test(rn) || rn.startsWith('kodyMemory')) {
        return 'kody_rules';
    }
    if (rn.startsWith('code-review') || rn.startsWith('analyzeCodeWithAI')) {
        return 'review';
    }
    if (SUGGESTION_RUN_NAMES.has(rn) || rn.startsWith('safeguard')) {
        return 'suggestions';
    }
    if (rn.startsWith('generateSummaryPR')) return 'summary';
    if (rn === 'conversationAgent' || phase === 'conversation') {
        return 'conversation';
    }
    return 'other';
}

/**
 * BACK-COMPAT de-para: infer the routing TASK from the process {@link
 * TokenUsageArea} for spans recorded BEFORE the router stamped `route` (and for
 * any call that wasn't task-routed). Old data has no `route` attribute, so
 * without this every historical/pre-launch span would show blank in the
 * per-task view; here it attributes to the task it de-facto served.
 *
 * The mapping is the inverse of how tasks fan out into areas: the whole code
 * review (defect finding + suggestion refinement) is the
 * `codeReview` task; kody-rules → `kodyRulesReview`; the PR summary →
 * `prSummary`; @kody chat → `conversation`. `system`/`other` stay '' — genuinely
 * not attributable to a routed task. Task strings are pinned to `LlmTask`
 * (@libs/llm/byok-config) — this low-level core module can't import it, mirrored
 * like SYSTEM_RUN_NAMES. When `route` IS stamped, it always wins over this.
 */
/**
 * The valid routing TASK values (`LlmTask` in @libs/llm/byok-config). Pinned
 * here — this low-level core module can't import it — and asserted against the
 * real enum by a unit test in the llm package. Used to GUARD the `route`
 * attribute: only a genuine task is trusted; anything else (a stale tier string
 * from a pre-realignment span, garbage) falls back to the area de-para, so the
 * per-task view never shows a non-task bucket like `default`/`taskOverride`.
 */
export const ROUTING_TASKS: ReadonlySet<string> = new Set([
    'codeReview',
    'kodyRulesReview',
    'ruleGeneration',
    'businessValidation',
    'prSummary',
    'conversation',
]);

export function routeFromArea(area: TokenUsageArea): string {
    switch (area) {
        case 'review':
        case 'suggestions':
            return 'codeReview';
        case 'kody_rules':
            return 'kodyRulesReview';
        case 'summary':
            return 'prSummary';
        case 'conversation':
            return 'conversation';
        default: // 'system' | 'other'
            return '';
    }
}

/**
 * Derives `tu` from a span's flat dotted-key attribute object. Returns `null`
 * for spans with no LLM usage (wrapper/parent spans) so callers can no-op.
 */
export function deriveTu(
    attrs: Record<string, any> | undefined | null,
): TokenUsageTu | null {
    if (!attrs) {
        return null;
    }
    const total = attrs['gen_ai.usage.total_tokens'];
    if (typeof total !== 'number' || total <= 0) {
        return null;
    }

    const rawModel = attrs['gen_ai.response.model'];
    // Canonical name collapses `google_gemini:gemini-2.5-pro` → `gemini-2.5-pro`
    // (last segment after ':'), identical to the read pipeline.
    const model =
        typeof rawModel === 'string' && rawModel
            ? rawModel.split(':').pop() || ''
            : '';

    const input = n(attrs['gen_ai.usage.input_tokens']);
    const runName = attrs['gen_ai.run.name'];
    const area = deriveArea(runName, attrs['agent.phase']);

    const credentialId = attrs['credentialId'];
    return {
        isByok: attrs['type'] === 'byok',
        sys: typeof runName === 'string' && SYSTEM_RUN_NAMES.has(runName),
        model,
        credentialId:
            typeof credentialId === 'string' && credentialId
                ? credentialId
                : '',
        input,
        output: n(attrs['gen_ai.usage.output_tokens']),
        total,
        reasoning: n(attrs['gen_ai.usage.reasoning_tokens']),
        cacheRead: n(attrs['gen_ai.usage.cache_read_input_tokens']),
        cacheWrite: n(attrs['gen_ai.usage.cache_creation_input_tokens']),
        area,
        // The router stamps the LlmTask as `route` (see llm-observability.ts /
        // resolveTaskSlot). A VALID task wins; otherwise (absent, or a stale
        // tier string from a pre-realignment span) fall back to the area→task
        // de-para — so old/garbage never shows as a bogus task bucket.
        route: ROUTING_TASKS.has(attrs['route'])
            ? attrs['route']
            : routeFromArea(area),
    };
}
