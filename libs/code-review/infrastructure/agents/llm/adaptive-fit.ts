/**
 * Resolves an "adaptive fit profile" — a set of flags that downstream
 * code (prompt builder, agent loop, orchestrator) consults to decide
 * whether to drop fidelity in order to fit a small model context window.
 *
 * PR1 ships the *plumbing only*: every profile returns full-fidelity
 * flags, so behavior is byte-identical to today. PR2/PR3 will flip flags
 * per-profile so the strategies actually fire. Splitting this way keeps
 * the wiring change reviewable on its own and lets us run a baseline
 * benchmark before changing any review output.
 *
 * Thresholds are educated guesses (8K / 16K / 32K / 64K). Once the
 * profile is in use we'll log which one each run picks and revisit.
 */

export type AdaptiveProfileKind =
    | 'full'
    | 'light'
    | 'compact'
    | 'minimal'
    | 'unviable';

export interface AdaptiveProfile {
    kind: AdaptiveProfileKind;
    contextWindowTokens: number;
    /** Render compact system prompt (skip workflow + most rules). */
    compactPrompt: boolean;
    /** Don't append callGraph to the user prompt. */
    dropCallGraph: boolean;
    /** Force every file's tier to 'optional' (hunk-headers-only diffs). */
    allOptional: boolean;
    /** Truncate individual file diffs to this many chars; undefined = no cap. */
    maxDiffChars: number | undefined;
    /** Disable verifier / second-chance / coverage-recovery / synthesis-rescue. */
    skipHeavyPasses: boolean;
    /** Apply low-signal file filter (tests/md/css) even in deep mode. */
    lowSignalFilterUnconditional: boolean;
}

const FULL_THRESHOLD = 64_000;
const LIGHT_THRESHOLD = 32_000;
const COMPACT_THRESHOLD = 16_000;
const MINIMAL_THRESHOLD = 8_000;

function classify(contextWindowTokens: number): AdaptiveProfileKind {
    if (!Number.isFinite(contextWindowTokens)) return 'full';
    if (contextWindowTokens <= 0) return 'unviable';
    if (contextWindowTokens >= FULL_THRESHOLD) return 'full';
    if (contextWindowTokens >= LIGHT_THRESHOLD) return 'light';
    if (contextWindowTokens >= COMPACT_THRESHOLD) return 'compact';
    if (contextWindowTokens >= MINIMAL_THRESHOLD) return 'minimal';
    return 'unviable';
}

/**
 * Per-file diff cap used by the `minimal` profile. 4K chars ≈ 1K tokens
 * per file is enough for ~20 hunks of context; long files get a
 * truncation marker. Tied to the profile so callers don't have to pick
 * the constant themselves.
 */
const MINIMAL_PROFILE_MAX_DIFF_CHARS = 4_000;

/**
 * Resolve the profile for a given context window. Each band cumulatively
 * activates strategies (light ⊂ compact ⊂ minimal). `full` and
 * `unviable` keep every flag off — `full` because it doesn't need them,
 * `unviable` because the preflight will throw before strategies could
 * help and we don't want to silently emit "fidelity reduced" warnings
 * for a doomed run.
 *
 * The flags are read by `BaseCodeReviewAgentProvider.execute`,
 * `agent-review.stage.ts`, and `agent-loop.ts` to gate their behavior.
 */
export function resolveAdaptiveProfile(
    contextWindowTokens: number,
): AdaptiveProfile {
    const kind = classify(contextWindowTokens);
    const resolvedWindow = Number.isFinite(contextWindowTokens)
        ? contextWindowTokens
        : 0;

    // Cumulative flag activation per band:
    const light = kind === 'light' || kind === 'compact' || kind === 'minimal';
    const compact = kind === 'compact' || kind === 'minimal';
    const minimal = kind === 'minimal';

    return {
        kind,
        contextWindowTokens: resolvedWindow,
        // light+: cheap wins — fewer tokens out, fewer follow-up calls.
        dropCallGraph: light,
        skipHeavyPasses: light,
        // compact+: trim the prompt itself and drop low-signal files
        // unconditionally (no longer gated on review mode).
        compactPrompt: compact,
        lowSignalFilterUnconditional: compact,
        // minimal: last resort. All files become hunk-headers-only and
        // long diffs get truncated to MINIMAL_PROFILE_MAX_DIFF_CHARS.
        // Quality drops noticeably here — only fires below 16K.
        allOptional: minimal,
        maxDiffChars: minimal ? MINIMAL_PROFILE_MAX_DIFF_CHARS : undefined,
    };
}
