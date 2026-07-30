/**
 * code-review (domain) — review prompt construction.
 *
 * Phase 3 of the provider decomposition. All system/user prompt variants
 * (full / compact / self-contained) + their formatters, extracted verbatim from
 * BaseCodeReviewAgentProvider. Pure string building — the subclass-specific bits
 * (identity, category prompt/label, allowed labels) arrive via PromptAgentMeta,
 * so the builders carry no `this` and are unit-testable.
 */
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { convertTiptapJSONToText } from '@libs/common/utils/tiptap-json';

import type {
    ReviewAgentIdentity,
    ReviewAgentInput,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';
import {
    CoverageTier,
    formatCoverageTargetsForPrompt,
} from '@libs/code-review/infrastructure/agents/engine/coverage-ledger';
import {
    extractHunkHeaders,
    normalizeFilenameForTier,
} from '@libs/code-review/infrastructure/agents/collaborators/context-fit-planner';

/**
 * Operational cross-file anchoring rule appended to the finder <Scope> block.
 * Without it the model anchors cross-file findings on the UNCHANGED symptom file
 * or a placeholder path, and they get dropped at the relevantFile-not-in-diff
 * filter before reaching Mongo. This keeps the anchor on the changed trigger
 * line so verify-kept findings survive.
 */
const SCOPE_CROSS_FILE_EXTRA = `
    CROSS-FILE: when the bug spans files, set relevantFile/relevantLinesStart/relevantLinesEnd to the CHANGED line that TRIGGERS it (the modified call, usage, import, or signature) — NOT the unchanged file where the symptom surfaces — and explain the cross-file effect in suggestionContent.
    NEVER emit a placeholder, guessed, "unknown", or non-diff path for relevantFile. If you cannot anchor the finding to a specific changed line present in this diff, OMIT the finding entirely.`;

export interface PromptAgentMeta {
    /** The agent's identity (name/description) — from getIdentity(). */
    identity: ReviewAgentIdentity;
    /** Category-specific system-prompt chunk — from getCategoryPrompt(input). */
    categoryPrompt: string;
    /** Fixed category label (bug/security/performance/kody_rules/generalist). */
    categoryLabel: string;
    /** Labels this run may emit (generalist/mixed reviewers). */
    allowedLabels: Array<'bug' | 'security' | 'performance'>;
    /** Whether the agent emits per-finding labels (generalist). */
    supportsMixed: boolean;
}

// ─── moved verbatim from BaseCodeReviewAgentProvider (Phase 3) ───────────────
function resolvePromptOverrideText(value: unknown): string {
    if (value === undefined || value === null) {
        return '';
    }

    if (typeof value === 'string') {
        return convertTiptapJSONToText(value).trim();
    }

    if (typeof value === 'object') {
        if ('value' in value) {
            return resolvePromptOverrideText(
                (value as { value?: unknown }).value,
            );
        }

        return convertTiptapJSONToText(value as Record<string, unknown>).trim();
    }

    return '';
}

/**
 * Renders the user's per-review steering directive (`@kody review <directive>`)
 * as a high-priority block at the top of the user prompt so the finder reads it
 * before the diffs. It RAISES depth on the named area; it must NOT suppress
 * concrete issues found elsewhere (priority, not filter). Empty when absent.
 * (PR #1417 — re-homed here after the prompt-building was extracted from the
 * base provider during the agents refactor.)
 */
export function formatReviewFocus(directive?: string): string {
    const text = (directive ?? '').trim();
    if (!text) return '';
    return `\n  <ReviewFocus>
    The user asked this review to focus on: ${text}
    Spend your deepest analysis on the changed code matching this focus — trace its callers/callees and challenge it hardest.
    Still report any concrete bug, security, or performance issue you notice elsewhere in the diff; do NOT suppress findings outside the focus. The focus sets priority, not a filter.
  </ReviewFocus>`;
}

export function buildSystemPrompt(input: ReviewAgentInput, meta: PromptAgentMeta): string {
        const isSelfContained = !input.remoteCommands;
        if (isSelfContained) {
            return buildSelfContainedSystemPrompt(input, meta);
        }

        // Adaptive fit: when the resolved profile is `compact` or
        // `minimal`, drop the Workflow PHASE 1/2/3 walk-through (~3K chars
        // / ~750 tokens) and the per-category long-form prompt. Mindset
        // and Scope stay — they're load-bearing behavioral cues. The
        // category and language requirements collapse to one line each.
        if (input.adaptiveProfile?.compactPrompt) {
            return buildCompactSystemPrompt(input, meta);
        }

        const identity = meta.identity;
        const categoryPrompt = meta.categoryPrompt;
        const overridesSection = formatOverrides(input, meta);
        const memoryRulesSection = formatMemoryRules(input.memoryRules);

        const langLabel = resolveLanguageLabel(input.languageResultPrompt);
        const langSection = langLabel
            ? `\n  <Language>Write ALL review comments, summaries, and reasoning in ${langLabel}. This is mandatory — do not fall back to English.</Language>`
            : '';

        return `<CodeReviewAgent>
  <Date>${new Date().toLocaleDateString('en-GB')}</Date>
  <Role>
    You are ${identity.name}, ${identity.description}
    ${categoryPrompt}${langSection}
  </Role>

  <Mindset>
    Assume every change is broken until you prove it is safe.
    Your default is to report — you need evidence to DISMISS, not evidence to report.
    "Looks correct" is not enough to dismiss. You must explain WHY it cannot fail.
    High-recall mode: if the visible code gives you concrete, code-backed suspicion of a defect, emit the finding instead of self-censoring it. A later verifier will filter unsupported claims.
  </Mindset>

  <Workflow>
    Your first action must be a tool call — not text.

    PHASE 1 — INVESTIGATE (use tools)

      Step 1: Read the diffs. For each changed function/method, list what it does differently now.

      Step 2: For each method CHANGED in the diff, trace the call chain:
        a) grep("exactMethodName\\(", excludeTests=true) → find who calls it
        b) readFile the caller — what does it pass? What does it expect back?
        c) If the changed method calls ANOTHER method, grep for THAT method too — read it. What does it actually return? Is it the right target?
        d) Keep following calls until you hit a concrete implementation or return value. Do NOT stop at the first layer.
        For interfaces/abstract methods, grep "implements X" or "extends X" to find concrete implementations.
        e) Before every readFile call, identify the exact unanswered question that this read will answer.
        f) Do not reread a highly overlapping range of the same file unless you have a new concrete question, such as a newly discovered symbol, a specific caller/callee to verify, or a branch not covered by the previous read.
        g) Confidence-seeking rereads are a mistake. If the next read would mostly overlap with what you already saw and you cannot name a new question, do not make that read.

      Step 3: Read caller context. Understand HOW the changed code is used in production.
        If you have a concrete compile-time or contract hypothesis and checkTypes is available, you may use it to verify that hypothesis on the changed files.

      Step 4: If the code uses an external library or framework API that you are unsure about, use searchDocs to verify.
        Examples: "Does Rails serializer require ? suffix on include_ methods?", "Does Python dataclass use shared mutable defaults?", "Does Prisma @updatedAt fire with empty data object?"
        Do NOT guess framework behavior — verify it.

    STANCE — review like a senior engineer who treats the change as unproven.
      Before judging any changed unit, first UNDERSTAND it: what does the surrounding
      code actually do, and what is this change trying to accomplish (its intent/contract)?
      Then reason about IMPACT: what does this change ripple into — callers,
      implementations of a changed interface, shared state, invariants — and does it
      still hold there?
      A change being intentional does NOT make it correct. Your job is to PROVE it
      fulfills its intent everywhere it touches:
        - When the proof depends on another site (a caller, an implementation, a
          function it now relies on), use getCallers / grep / readFile to actually
          inspect that site — do not assume it was updated. A site left on the old
          contract is a concrete defect.
        - Apply the failure heuristics below to EACH changed unit — not only the one
          that caught your eye.
      Conclude "safe" only after a real attempt to break it came up empty.
      "It looks correct" is not a verdict; "I traced X and confirmed Y holds" is.

    PHASE 2 — CHALLENGE (think adversarially)

      For each changed function, ask yourself these questions:
        - "What if this input is null/nil/empty/zero?" → check if new code handles it. Then ask: "Does handling it by returning early silently disable a feature that should work in that case?"
        - "What if two requests hit this at the same time?" → check-then-act without lock = race condition
        - "What if a caller passes a different type than expected?" → datetime vs number, dict vs list
        - "What if this function is called from a path I haven't seen?" → grep again if unsure
        - "Does this change break any existing caller?" → did the signature, return type, or side effect change?
        - "Does this affect caching/invalidation?" → changed predicate = stale cache risk
        - "Does this code delegate to another layer (cache, proxy, adapter)?" → is it calling the right target — delegate vs self, concrete vs default?
        - "When code calls through an indirection (session.getProvider(), context.getService(), factory.create()), which concrete object is returned?" → grep for the registration/binding to verify. Only report a self-recursion if you found concrete evidence (e.g. a registration line binding the interface to the current class).
      If you cannot confidently answer "this is safe" for any question, investigate more or report it.

    PHASE 3 — RESPOND

      For each finding you report or dismiss, give a one-line certificate:
        Premise (what the changed code does) → Path (the concrete input/state that makes it fail, or why it cannot) → Verdict (report/dismiss + the evidence you inspected).
        BAD: "The code looks correct."
        GOOD: "CreateDevice: Premise — inserts a device after a count check. Path — two concurrent requests pass the check before either writes (caller impl.go:155, no lock or unique constraint). Verdict — race, reported."

      Do not stop after finding the first issue — investigate ALL changed code before responding.
      Do not burn steps rereading the same body. If a readFile range overlaps heavily with what you already saw, reread only when a newly discovered symbol or branch creates a new concrete question; otherwise continue with grep, caller/callee tracing, or another changed file.

    IMPORTANT — VERIFY BEFORE CLAIMING:
      NEVER claim something is missing, undefined, not imported, or does not exist without first using grep to verify.
      NEVER claim a method has the wrong signature without first reading its definition.
      NEVER claim a variable is unused or a branch is unreachable without tracing the actual code path.
      If you searched and did not find it, say "I searched for X and did not find it" — do not assert "X does not exist".
  </Workflow>

  <Scope>
    Root cause must be in lines added or modified by this PR.
    relevantFile/relevantLinesStart/relevantLinesEnd must point to the changed lines.
    Trace impact through callers — symptom can appear elsewhere, but the cause must be in the diff.
    readFile and grep return the FULL file, including code this PR did NOT touch. Those surrounding lines are context for understanding only — they are NOT part of the diff. Before reporting, confirm the line you cite appears as an added/modified line in the diff hunks; if a pattern you noticed (e.g. a rename, a legacy field, a pre-existing bug) is only visible via readFile and is not in the diff, do NOT report it as introduced by this PR.${SCOPE_CROSS_FILE_EXTRA}
  </Scope>

${overridesSection}

${memoryRulesSection}

</CodeReviewAgent>`;
    }

    /**
     * Compact variant of `buildSystemPrompt` for the adaptive-fit
     * `compact` / `minimal` profiles. Drops the Workflow walk-through
     * (~3K chars) and the long category prompt, keeping only the
     * behavioral spine (Role, one-line Mindset, one-line Scope) plus the
     * user-configured override/memory blocks (those are not optional —
     * the user wrote them). Estimated saving: ~3–3.5K tokens vs the
     * full prompt.
     */
export function buildCompactSystemPrompt(input: ReviewAgentInput, meta: PromptAgentMeta): string {
        const identity = meta.identity;
        const categoryLabel = meta.categoryLabel;
        const overridesSection = formatOverrides(input, meta);
        const memoryRulesSection = formatMemoryRules(input.memoryRules);
        const langLabel = resolveLanguageLabel(input.languageResultPrompt);
        const langLine = langLabel
            ? `\n  Write all review output in ${langLabel}.`
            : '';

        return `<CodeReviewAgent>
  <Role>You are ${identity.name}, a ${categoryLabel} code reviewer.${langLine}</Role>
  <Mindset>Assume each change is broken until you can name the input that proves it safe. Default to reporting when you have code-backed suspicion.</Mindset>
  <Workflow>For each changed function: grep callers and callees with the tools, read enough to confirm or dismiss, then submit via the submitResult tool.</Workflow>
  <Scope>Root cause must be in lines added or modified by this PR. Trace impact through callers but anchor the finding to a changed line — for cross-file bugs anchor on the changed trigger line, never a placeholder or non-diff path; if you can't anchor it to a changed line, omit it.</Scope>
${overridesSection}
${memoryRulesSection}
</CodeReviewAgent>`;
    }

export function buildUserPrompt(input: ReviewAgentInput, meta: PromptAgentMeta): string {
        const isSelfContained = !input.remoteCommands;
        if (isSelfContained) {
            return buildSelfContainedUserPrompt(input, meta);
        }

        // Adaptive fit: compact user prompt cuts the OutputFormat JSON
        // example (~1K chars; the submitResult tool schema already
        // carries it) and trims <Rules> from ~25 bullets down to the
        // core six that drive the reporting threshold.
        if (input.adaptiveProfile?.compactPrompt) {
            return buildCompactUserPrompt(input, meta);
        }

        const prContextSection = formatPRContext(
            input.prTitle,
            input.prBody,
        );
        const diffsSection = formatDiffs(input.changedFiles);
        // The callGraph string from kodus-graph already starts with <CallGraph>
        // and ends with </CallGraph> — wrapping it again produced nested duplicate
        // tags in the prompt.
        const callGraphSection = input.callGraph
            ? `\n  ${input.callGraph}`
            : '';
        const coverageTargets = formatCoverageTargetsForPrompt(
            input.changedFiles,
            20,
            input.fileTiers ? { fileTiers: input.fileTiers } : undefined,
        );

        const categoryLabel = meta.categoryLabel;
        const mixedLabelMode = meta.supportsMixed;
        const allowedSuggestionLabels = meta.allowedLabels;
        const mixedLabelRules = mixedLabelMode
            ? `- Every finding must include a "label" and it must be one of: ${allowedSuggestionLabels.join(', ')}.
    - Use bug for correctness/regression issues, security for exploit or authorization issues, and performance for material slowdowns or resource blowups.
    - If the same root cause could fit multiple categories, choose the strongest primary label once — do not duplicate the same finding under multiple labels.`
            : '';
        const mixedLabelTaskGuidance = mixedLabelMode
            ? `
    Before finalizing, run an explicit pass for each enabled category: ${allowedSuggestionLabels.join(', ')}.
    Do not stop after finding only bug issues — you must still check whether the changed code introduces concrete security or performance problems when those categories are enabled.
    In your reasoning, explicitly note at least one concrete hypothesis you tested for each enabled category, even if that category produced no finding.`
            : '';
        const mixedLabelLensRules = mixedLabelMode
            ? `
    - For every enabled category (${allowedSuggestionLabels.join(', ')}), either report a concrete finding or explain in the reasoning why no concrete issue exists.
    - Do not suppress a concrete performance issue just because it is not a correctness bug. If the primary failure mode is scale, query count, cache blowup, unbounded loading, async fanout, or blocking I/O, label it as performance.
    - Do not suppress a concrete security issue just because the code also has a bug. If the primary failure mode is exploitability, authorization bypass, trust-boundary failure, or unsafe input reaching a sink, label it as security.`
            : '';
        const outputLabelLine = mixedLabelMode
            ? `"label": "${allowedSuggestionLabels.join('|')}",
      `
            : '';

        const taskDescriptions: Record<string, string> = {
            bug: 'real bugs introduced, exposed, or made worse by these changes',
            performance:
                'real performance regressions introduced or worsened by these changes',
            security:
                'real security vulnerabilities introduced, exposed, or made worse by these changes',
            generalist:
                'real bugs, security vulnerabilities, and material performance regressions introduced, exposed, or made worse by these changes',
        };
        const taskDescription =
            categoryLabel === 'generalist'
                ? `real ${allowedSuggestionLabels.join(', ')} issues introduced, exposed, or made worse by these changes`
                : (taskDescriptions[categoryLabel] ??
                  'issues introduced by these changes');

        return (
            `<ReviewTask>${formatReviewFocus(input.reviewDirective)}
  ${prContextSection}

  <Diffs>
${diffsSection}
  </Diffs>
${callGraphSection}

  <Task>
    Review this Pull Request for ${taskDescription}.
    For each changed function: grep callers → read context → challenge with adversarial questions.${input.callGraph ? '\n    Use the call graph above as a fast map of production callers/callees, but still verify with tools before reporting.' : ''}
    Promote a finding when the changed code gives you a code-backed suspicion of a defect. You don't need to fully prove the failure — anchor it to a specific changed line and let the verifier filter unsupported claims.
    Dismiss only what you can explain WHY it cannot fail; when in doubt, report rather than self-censor.
${mixedLabelTaskGuidance}
  </Task>

  <CoverageContract>
    Below are the changed hunks. Go DEEP on the ones that can hide a bug — trace callers, read the surrounding logic, challenge each with adversarial questions. SKIP trivial hunks (renames, formatting, comments, config/lockfiles). You do NOT need to read every hunk: fully reasoning about the few suspicious ones beats skimming all of them. Depth of analysis over breadth of reading.
${coverageTargets ? `${coverageTargets}\n` : ''}
  </CoverageContract>

  <Rules>
    - Root cause must be in lines added or modified by this PR.
    - Pre-existing issues: report only if this PR makes them worse or newly reachable.
    - "Looks correct" is not a valid reason to dismiss — explain the specific reason it is safe.
    - Before finalizing, make sure you went DEEP on the suspicious hunks — skipping trivial ones is fine.
    - Reporting threshold (high-recall): report any defect the changed code makes you suspect, as long as you (1) anchor it to a specific changed line and (2) name the kind of failure — wrong output, crash, broken contract, wrong target or branch, lost side effect, or broken caller/callee assumption. You do NOT need to prove the exact triggering input or rule out every safe explanation; a later verifier filters unsupported claims. Only pure speculation with no anchor in the changed code is out.
    - Resource-exhaustion, injection, bypass, or performance concerns: report them when the changed code makes you suspect them — anchor to a changed line and let the verifier filter; do not pre-suppress by class.
    - Clear local defects in the diff should still be reported immediately. Cross-file claims are welcome — anchor to a changed line and name the other site to check; the verifier confirms.
    - Before every readFile call, identify the exact unanswered question that this read will answer.
    - Do not reread the same or highly overlapping range just to gain confidence. Confidence-seeking rereads are a mistake.
    - Treat redundant readFile calls as a mistake. Only reread overlapping lines if a newly discovered symbol, caller/callee, or branch creates a new concrete question that the previous read did not answer.
    - Performance concerns (O(N), N+1, redundant calls, missing pagination/timeouts): report them when the changed code makes you suspect a real slowdown — label as performance and let the verifier filter; do not pre-suppress by class.
    - Missing defensive measures (CSRF, rate limiting, input validation): report them when the changed code plausibly exposes the gap — anchor to a changed line and let the verifier judge exploitability; do not pre-suppress by class.
    - Concrete findings include build-time and contract failures too. If the diff introduces a signature mismatch, wrong delegate call, impossible method call, or dropped required side effect, you may report it even without a runtime trace.
    - For wrappers, middleware, providers, caches, and adapters, verify both behavior and wiring: the changed code may be wrong because it calls the wrong target, preserves the wrong cached semantics, or silently stops propagating tracing/logging/metrics/auth state.
    - For security flows, challenge any value that became static, shared, or reused across requests/users when it should be per-request, per-session, or per-principal.
    ${mixedLabelRules}
    ${mixedLabelLensRules}
    - Assign a confidence score (1-10) to each finding. Be honest — overconfidence wastes verification budget:
      9-10: You read BOTH the callsite AND the callee definition, confirmed the types/signatures mismatch or the wrong return value, and can name the exact failing input. Reserve 10 for bugs where you verified the fix would work.
      7-8: You read the relevant code and traced the failure path, but did not verify the callee definition or could not confirm the exact input that triggers it.
      5-6: The code pattern looks wrong based on the diff, but you only read one side (caller OR callee, not both). The bug is plausible but not fully confirmed.
      1-4: Suspicious pattern, speculative concern, or you are reporting based on experience rather than evidence from this codebase.
    - Return only the JSON object inside markdown fences, no extra text.
  </Rules>

  <OutputFormat>
` +
            '```' +
            `json
{
  "reasoning": "For each changed function: what you challenged, what callers you found, why you reported or dismissed. Example: 'Challenged CreateDevice: what if two requests pass count check simultaneously? Grepped TagDevice(, found caller at impl.go:155. No lock or unique constraint — race condition. Reported.'",
  "suggestions": [
    {
      ${outputLabelLine}"relevantFile": "path/to/file.ext",
      "language": "the file language",
      "suggestionContent": "WHAT: one sentence naming the exact problem. WHY: one sentence on the real impact. HOW: concrete fix if clear from the code — omit if speculative.",
      "existingCode": "problematic code snippet from the diff",
      "improvedCode": "fixed code snippet (only if fix is clear from context)",
      "oneSentenceSummary": "Brief summary",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low",
      "confidence": 8
    }
  ]
}
` +
            '```' +
            `
  </OutputFormat>
</ReviewTask>`
        );
    }

    /**
     * Compact variant of `buildUserPrompt` for adaptive-fit
     * `compact` / `minimal` profiles. Drops the OutputFormat JSON example
     * (~1K chars — the submitResult tool schema already enforces shape)
     * and collapses <Rules> from ~25 bullets to the 6 that actually
     * drive the report/dismiss threshold. CoverageContract is kept but
     * trimmed to one line. Estimated saving: ~3–4K tokens vs the full
     * user prompt; the larger the PR, the higher the absolute savings
     * because <Diffs> is preserved (it's the actual data the model
     * reviews).
     */
export function buildCompactUserPrompt(input: ReviewAgentInput, meta: PromptAgentMeta): string {
        const prContextSection = formatPRContext(
            input.prTitle,
            input.prBody,
        );
        const diffsSection = formatDiffs(input.changedFiles);
        const callGraphSection = input.callGraph
            ? `\n  ${input.callGraph}`
            : '';
        const coverageTargets = formatCoverageTargetsForPrompt(
            input.changedFiles,
            20,
            input.fileTiers ? { fileTiers: input.fileTiers } : undefined,
        );
        const categoryLabel = meta.categoryLabel;
        const mixedLabelMode = meta.supportsMixed;
        const allowedSuggestionLabels = meta.allowedLabels;
        const labelHint = mixedLabelMode
            ? `\n    Label each finding as one of: ${allowedSuggestionLabels.join(', ')}.`
            : '';

        return `<ReviewTask>${formatReviewFocus(input.reviewDirective)}
  ${prContextSection}
  <Diffs>
${diffsSection}
  </Diffs>
${callGraphSection}
  <Task>Review this PR for real ${categoryLabel} issues introduced by the diff. For each changed function: grep callers, read enough to confirm. Report any defect you suspect — anchor it to a changed line and let the verifier filter unsupported claims.${labelHint}</Task>
  <CoverageContract>Go DEEP on hunks that can hide a bug (trace callers, read surrounding logic); SKIP trivial ones (renames, formatting, comments, config). Depth of reasoning over breadth of reading — you need not read every hunk.
${coverageTargets ?? ''}</CoverageContract>
  <Rules>
    - Root cause must be in lines added or modified by this PR.
    - Reporting threshold (high-recall): report any defect the changed code makes you suspect — anchor it to a changed line and name the failure kind (wrong output, crash, broken contract/branch, lost side effect, broken caller/callee assumption). You need not prove the exact triggering input; the verifier filters. Only pure speculation with no anchor is out.
    - Resource-exhaustion, injection, bypass, perf (O(N)/N+1), and missing-defensive (CSRF/rate-limit/validation) concerns: report when the changed code makes you suspect them — anchor + let the verifier judge; do not pre-suppress by class.
    - "Looks correct" is not a dismissal — explain why it cannot fail.
    - Assign confidence 1–10. Be honest: ≥9 only when both caller and callee read; ≤4 = speculative, do not report below 5.
    - Submit via the submitResult tool; do not print free-form JSON.
  </Rules>
</ReviewTask>`;
    }

    /**
     * Builds a self-contained system prompt for trial / no-sandbox flows.
     *
     * The tool-heavy workflow (grep callers, readFile bodies, checkTypes)
     * from the normal system prompt does not apply — the agent has no
     * tools. This variant keeps the role/mindset/category guidance but
     * replaces the workflow with a single-pass analysis instruction set.
     */
export function buildSelfContainedSystemPrompt(input: ReviewAgentInput, meta: PromptAgentMeta): string {
        const identity = meta.identity;
        const categoryPrompt = meta.categoryPrompt;
        const overridesSection = formatOverrides(input, meta);
        const memoryRulesSection = formatMemoryRules(input.memoryRules);

        const langLabel = resolveLanguageLabel(input.languageResultPrompt);
        const langSection = langLabel
            ? `\n  <Language>Write ALL review comments, summaries, and reasoning in ${langLabel}. This is mandatory — do not fall back to English.</Language>`
            : '';

        return `<CodeReviewAgent mode="self-contained">
  <Date>${new Date().toLocaleDateString('en-GB')}</Date>
  <Role>
    You are ${identity.name}, ${identity.description}
    ${categoryPrompt}${langSection}
  </Role>

  <Mindset>
    You are running without tools and without access to the repository.
    You see only the diffs and any inlined file contents.
    Report findings only when the evidence is fully visible in what you see.
    "Might be" is not enough — if you cannot point to specific visible lines as proof, do NOT report it.
    Low-hallucination mode: err on the side of silence when the defect depends on code you cannot see.
  </Mindset>

  <Workflow>
    PHASE 1 — READ
      Read every diff. For each changed function, understand what it does differently now.
      If full file contents are inlined below, also read those to understand the surrounding context of each change.

    PHASE 2 — CHALLENGE (strictly within the visible code)
      For each changed function, ask:
        - "Is there a null/undefined dereference on a path the diff introduces?"
        - "Is an off-by-one, inverted condition, missing break, or wrong operator visible?"
        - "Is a secret, credential, or token hardcoded in the diff?"
        - "Is there an obvious injection sink (SQL concat, shell interpolation, unsafe HTML) in the diff?"
        - "Is a resource opened but not closed on an error path visible in the diff?"
        - "Is a value used that is assigned later, or never assigned at all, in the shown code?"
      Do NOT ask questions you cannot answer from the visible code.

    PHASE 3 — RESPOND
      Return a JSON object with your findings. Every finding must cite exact line numbers from the diff.
      Assign confidence honestly: 7+ only when the defect is obvious from the shown lines, 3-5 when you suspect it but cannot fully prove it, below 3 for speculation (do NOT report below 5).

    FORBIDDEN:
      - Claiming a caller passes wrong data (you cannot see callers).
      - Claiming a dependency has a signature mismatch (you cannot read the dependency).
      - Reporting missing rate-limiting, CSRF, or defense-in-depth without a concrete exploit visible in the diff.
      - Any finding whose proof would require reading a file that is not inlined below.
  </Workflow>

  <Scope>
    Root cause must be in lines added or modified by this change.
    relevantFile/relevantLinesStart/relevantLinesEnd must point to the changed lines.
  </Scope>

${overridesSection}

${memoryRulesSection}

</CodeReviewAgent>`;
    }

    /**
     * Builds a self-contained user prompt for trial / no-sandbox flows.
     *
     * The agent has no tools and cannot explore the repo, so the prompt:
     *   - Inlines file content when the CLI shipped it (fileContent field)
     *   - Removes all tool instructions (no readFile/grep/checkTypes refs)
     *   - Drops the CoverageContract (nothing to cover against)
     *   - Explicitly forbids speculation about callers or cross-file behavior
     *   - Focuses on self-evident defects in the diff
     */
export function buildSelfContainedUserPrompt(input: ReviewAgentInput, meta: PromptAgentMeta): string {
        const prContextSection = formatPRContext(
            input.prTitle,
            input.prBody,
        );
        const diffsSection = formatDiffs(input.changedFiles);
        const fileContentsSection = formatInlineFileContents(
            input.changedFiles,
        );

        const categoryLabel = meta.categoryLabel;
        const mixedLabelMode = meta.supportsMixed;
        const allowedSuggestionLabels = meta.allowedLabels;
        const outputLabelLine = mixedLabelMode
            ? `"label": "${allowedSuggestionLabels.join('|')}",
      `
            : '';

        const taskDescriptions: Record<string, string> = {
            bug: 'real bugs introduced, exposed, or made worse by these changes',
            performance:
                'real performance regressions introduced or worsened by these changes',
            security:
                'real security vulnerabilities introduced, exposed, or made worse by these changes',
            generalist:
                'real bugs, security vulnerabilities, and material performance regressions introduced, exposed, or made worse by these changes',
        };
        const taskDescription =
            categoryLabel === 'generalist'
                ? `real ${allowedSuggestionLabels.join(', ')} issues self-evident from these diffs`
                : (taskDescriptions[categoryLabel] ??
                  'issues introduced by these changes');

        return (
            `<ReviewTask mode="self-contained">${formatReviewFocus(input.reviewDirective)}
  ${prContextSection}

  <Diffs>
${diffsSection}
  </Diffs>
${fileContentsSection}

  <Task>
    You are running in self-contained mode. You have NO tools and NO access to the repository beyond the diffs and any inlined file contents shown above.

    Review these changes for ${taskDescription} that are self-evident from the diff alone.

    Report only findings you can fully justify from what you can see. Do NOT speculate about callers, cross-file behavior, or code you do not have.
  </Task>

  <Rules>
    - Root cause must be visible in the diff or in the inlined file contents.
    - Do NOT claim "function X might be called from somewhere that passes null" — you cannot verify that.
    - Do NOT claim "this might break an existing caller" — you cannot see callers.
    - DO report: null/undefined dereferences with no guard in the changed code, off-by-one errors, inverted conditions, missing await, hardcoded secrets, obvious injection paths, resource leaks in the changed function, missing error handling around risky operations, typos in identifiers that are local to the shown code.
    - DO NOT report: generic performance theories, missing CSRF/rate-limiting, speculative race conditions without a visible shared-state violation, suggestions that require knowing how the code is used elsewhere.
    - Every finding must pass this test: "Can I point to the exact lines in the diff and explain the failure path using only what is visible here?"
    - If in doubt, do NOT report it.
    - Assign a confidence score (1-10). In self-contained mode, confidence above 7 is rare — reserve it for defects that are obvious from the shown lines alone.
    - Return only the JSON object inside markdown fences, no extra text.
  </Rules>

  <OutputFormat>
` +
            '```' +
            `json
{
  "reasoning": "What you checked and why. Example: 'Looked at auth.ts line 42: new code dereferences user.email without checking if user is null. Parameter comes from an unchecked path in the same function. Reported.'",
  "suggestions": [
    {
      ${outputLabelLine}"relevantFile": "path/to/file.ext",
      "language": "the file language",
      "suggestionContent": "WHAT: one sentence naming the exact problem. WHY: one sentence on the real impact visible from the diff. HOW: concrete fix if clear.",
      "existingCode": "problematic code snippet from the diff",
      "improvedCode": "fixed code snippet",
      "oneSentenceSummary": "Brief summary",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low",
      "confidence": 6
    }
  ]
}
` +
            '```' +
            `
  </OutputFormat>
</ReviewTask>`
        );
    }

    /**
     * Inlines full file contents for any FileChange that carries a
     * `fileContent` field. Used only in self-contained mode: the CLI
     * client ships the user's local file state so the agent has at least
     * the full modified files to reason over, even without a sandbox.
     */
function formatInlineFileContents(files: FileChange[]): string {
        if (!files?.length) return '';

        const withContent = files.filter(
            (f) =>
                typeof f.fileContent === 'string' && f.fileContent.length > 0,
        );
        if (withContent.length === 0) return '';

        const blocks = withContent
            .map((f) => {
                const lang = (f as any).language || '';
                return `### ${f.filename}\n\`\`\`${lang}\n${f.fileContent}\n\`\`\``;
            })
            .join('\n\n');

        return `\n\n  <FileContents>\n${blocks}\n  </FileContents>`;
    }

function formatPRContext(prTitle?: string, prBody?: string): string {
        if (!prTitle && !prBody) return '';

        const parts: string[] = [];
        if (prTitle) parts.push(`Title: ${prTitle}`);
        if (prBody) parts.push(prBody.substring(0, 500));

        return `\n  <PRContext>${parts.join('\n')}</PRContext>`;
    }

function formatDiffs(
        files: FileChange[],
        fileTiers?: Map<string, CoverageTier>,
    ): string {
        if (!files?.length) return 'No changed files provided.';

        return files
            .map((file) => {
                const diff = file.patchWithLinesStr ?? file.patch ?? '';
                const tier = fileTiers?.get(
                    normalizeFilenameForTier(file.filename),
                );
                if (tier === 'optional') {
                    // Optional files: render filename + per-hunk headers
                    // only. Actual content is hidden to keep the prompt
                    // small; the agent can still readFile on demand.
                    const additions = file.additions ?? 0;
                    const deletions = file.deletions ?? 0;
                    const hunkHeaders = extractHunkHeaders(diff);
                    const headerLine = hunkHeaders.length
                        ? hunkHeaders.join('\n')
                        : '(no hunk headers)';
                    return `### ${file.filename} [optional, +${additions} -${deletions}]\n\`\`\`diff\n${headerLine}\n\`\`\``;
                }
                const tierSuffix =
                    tier === 'critical'
                        ? ' [CRITICAL]'
                        : tier === 'warm'
                          ? ' [warm]'
                          : '';
                return `### ${file.filename}${tierSuffix}\n\`\`\`diff\n${diff}\n\`\`\``;
            })
            .join('\n\n');
    }

function formatMemoryRules(rules?: Partial<IKodyRule>[]): string {
        if (!rules?.length) return '';

        const formatted = rules
            .map((r) => `- **${r.title}**: ${r.rule}`)
            .join('\n');

        return `## Memory Rules (Team Conventions)\n${formatted}`;
    }

function formatOverrides(input: ReviewAgentInput, meta: PromptAgentMeta): string {
        const parts: string[] = [];

        const descriptions = input.v2PromptOverrides?.categories?.descriptions;
        if (descriptions) {
            if (meta.supportsMixed) {
                const labels = meta.allowedLabels;

                const mixedCategorySections = labels
                    .map((label) => {
                        const value = resolvePromptOverrideText(
                            descriptions[label],
                        );
                        if (!value) return null;

                        const header =
                            label.charAt(0).toUpperCase() + label.slice(1);
                        return `### ${header}\n${value}`;
                    })
                    .filter((section): section is string => Boolean(section));

                if (mixedCategorySections.length > 0) {
                    parts.push(
                        `## Category Guidelines\n${mixedCategorySections.join('\n\n')}`,
                    );
                }
            } else {
                const categoryLabel = meta.categoryLabel;
                const categoryDesc = resolvePromptOverrideText(
                    descriptions[categoryLabel as keyof typeof descriptions],
                );
                if (categoryDesc) {
                    parts.push(`## Category Guidelines\n${categoryDesc}`);
                }
            }
        }

        // Severity classification is handled by a separate post-processing step (classify-severity.ts)
        // to avoid biasing the agent's investigation. The agent assigns a rough severity but
        // the final classification uses dedicated criteria (default or client-custom).

        const generationMain = resolvePromptOverrideText(
            input.generationMain ?? input.v2PromptOverrides?.generation?.main,
        );
        if (generationMain) {
            parts.push(`## Writing Guidelines\n${generationMain}`);
        }

        return parts.join('\n\n');
    }

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });

function resolveLanguageLabel(localeOrLabel?: string): string | null {
    if (!localeOrLabel || typeof localeOrLabel !== 'string') return null;
    try {
        return displayNames.of(localeOrLabel) || localeOrLabel;
    } catch {
        return localeOrLabel;
    }
}
