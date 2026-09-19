/**
 * code-review (domain) — the "expert panel" extra pass: N role-specific finder
 * passes over the WHOLE PR diff (language specialist, security, performance,
 * QA, and a conditional DBA), followed by ONE arbitration pass that reconciles
 * their claims into a final verdict per finding.
 *
 * Distinct from the critical-file / atomic passes (which narrow SCOPE — one
 * file or hunk at a time): this narrows FOCUS instead — same full diff, but
 * each pass reads it through one lens with a small, undiluted checklist,
 * rather than one pass juggling every concern at once. Cost is a small,
 * roughly-fixed multiplier (N roles + 1 arbitration), not proportional to diff
 * size like the atomic passes were.
 *
 * Evidence for the shape (not just decorative persona labels): structured
 * multi-persona debate — independent claims, then cross-examination, then a
 * vote/verdict — showed real reasoning gains in the literature (up to +13% on
 * logic-puzzle benchmarks). A single "act as an expert" label with no
 * cross-examination step showed weak, sometimes negative, unstable results.
 * This is why arbitration is a required second step, not decoration on top of
 * N independent passes merged blindly (that would just be heavy resample with
 * extra words).
 */
import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { FinderSuggestion } from './finder.agent';

export interface ExpertRole {
    name: string;
    /** What this role uniquely looks for — kept short and undiluted on
     *  purpose; a role with a 20-bullet checklist is just the generalist
     *  again. */
    focus: string;
}

const EXTENSION_LANGUAGE: Record<string, string> = {
    rb: 'Ruby',
    go: 'Go',
    py: 'Python',
    java: 'Java',
    kt: 'Kotlin',
    ts: 'TypeScript',
    tsx: 'TypeScript',
    js: 'JavaScript',
    jsx: 'JavaScript',
    rs: 'Rust',
    cs: 'C#',
    php: 'PHP',
};

export function detectFileLanguage(filename: string): string | undefined {
    const ext = filename.split('.').pop()?.toLowerCase();
    return ext ? EXTENSION_LANGUAGE[ext] : undefined;
}

/** Every distinct language among the changed files, most-changed-files first —
 *  so a PR touching one Go file and five Ruby files gets a Ruby specialist
 *  first, not an arbitrary one. Deterministic, no LLM. */
export function detectPrLanguages(changedFiles: FileChange[]): string[] {
    const counts = new Map<string, number>();
    for (const f of changedFiles ?? []) {
        const lang = f?.filename ? detectFileLanguage(f.filename) : undefined;
        if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
}

const DB_PATH_PATTERNS = [
    // `migrate/` (Rails convention) and `migrations/` (most other frameworks).
    /(^|\/)(migrations?|migrate)\//i,
    /\.sql$/i,
    /schema\.(prisma|rb)$/i,
    /(^|\/)db\/(seeds|structure)\./i,
];

/** Whether this PR touches migration/schema/raw-SQL surface — the DBA role is
 *  a no-op pass (wasted cost) on a PR that never touches this, so it is gated
 *  on this check rather than always included. */
export function touchesDatabaseSurface(changedFiles: FileChange[]): boolean {
    return (changedFiles ?? []).some(
        (f) => f?.filename && DB_PATH_PATTERNS.some((p) => p.test(f.filename)),
    );
}

const FIXED_ROLES: ExpertRole[] = [
    {
        name: 'Security Specialist',
        focus: 'Exploit paths: untrusted input reaching a sink (command, URL fetch, file path, query, deserialization), broken auth/access-control boundaries, secrets or tokens handled unsafely, trust assumptions that changed.',
    },
    {
        name: 'Performance Specialist',
        focus: 'Material slowdowns: queries or network calls inside a loop, missing pagination/limits on data that can grow unbounded, blocking calls on a hot/async path, algorithmic complexity that got worse.',
    },
    {
        name: 'QA / Test Specialist',
        focus: "Whether the tests actually cover this change correctly: a test asserting the wrong thing (wrong HTTP verb, wrong expected value), a removed or weakened assertion, a behavior change with no test touching it, a test that would pass even if the fix were reverted.",
    },
];

/** Alternate roster (A/B knob `recognitionPanel`, see finder.agent.ts): fixed
 *  roles chosen from this session's ceiling audit, not by category
 *  (security/performance/QA) but by RECOGNITION FAILURE MODE — 30-PR audit
 *  found only ~3% of missed goldens were due to missing information (the
 *  finder never saw the relevant code); ~42%+ were the finder reading the
 *  right code and not connecting it to a defect. Every role below targets a
 *  specific confirmed pattern of that connection failure, not a topic.
 *
 *  MEASURED (20 PRs, standalone via `recognitionPanel` — replacing the
 *  generalist, not layered on top) and discarded: F1 0.361, well below the
 *  reference config (batedor calibrado + investigador + secondLookSameFile,
 *  F1 0.432-0.456 on the same PRs). Golden-by-golden: 19 of the panel's 20
 *  findings were already covered by the reference; only 1 was unique (a
 *  race condition). The recognition-failure framing didn't translate into
 *  a working mechanism — targeting the RIGHT failure mode conceptually
 *  didn't make these roles better investigators in practice. Kept as a
 *  roster, not a validated config. */
export const RECOGNITION_PANEL_ROLES: ExpertRole[] = [
    {
        name: 'Contract Auditor',
        focus: "Whether a changed method's actual behavior still matches its DECLARED contract — the Javadoc/docstring/interface signature it implements or overrides (nullability, thrown exceptions, side effects, required parameters). If the declaration isn't in the diff, grep/readFile the interface/superclass/parent it implements. A caller that happens to tolerate a violated contract is NOT proof the change is safe — the violated contract itself is the defect, since callers you have not traced may rely on it. Only report when you can point to the specific declared guarantee that no longer holds.",
    },
    {
        name: 'Data-Flow / Reference Tracer',
        focus: "Trace every value this diff touches from its origin (assignment, parameter, field read) to where it's finally used, returned, compared, or logged. Flag when the value at the END of that trace is NOT the one that was actually modified or intended — a similarly-named variable, a stale reference, a value compared against itself, a config object mutated but the original returned instead of the updated one. Ground every flag in the specific two variable names or expressions that got swapped or conflated.",
    },
    {
        name: 'Cross-Method Consistency Checker',
        focus: 'For every method this diff changes, read the OTHER methods in the same class/module (grep/readFile beyond the diff) and check whether the changed method still applies the same guard, permission check, version, or invariant the sibling methods apply. Flag inconsistencies: a check present in sibling methods but missing or downgraded in the changed one, a version/flag used elsewhere in the class but not here. A defect here is invisible from the diff alone — you must actually read the rest of the class.',
    },
    {
        name: 'Failure-Path Specialist',
        focus: 'Focus only on what happens when the happy-path assumption breaks: a catch block, an early return, a fallback branch, a retry, a cache/state write on the ERROR path. Flag when a failure is silently swallowed, when a fallback writes a value that overwrites something still-valid, when an error path skips a side effect (logging, cleanup, propagation) the happy path performs. Mishandled error paths are a disproportionate source of catastrophic production failures — take this seriously even when the happy path looks fine.',
    },
];

const DBA_ROLE: ExpertRole = {
    name: 'Database Specialist',
    focus: 'Migration safety (a down() that fails while new values are still in use, blocking DDL without CONCURRENTLY, ALTER TYPE without migrating existing rows), transaction/isolation correctness, and schema-application contract mismatches.',
};

/** The role roster for this PR: one language specialist per distinct language
 *  present (dynamic — the language and its name are the only thing that
 *  changes in the prompt), the fixed roles, and the DBA only when the diff
 *  actually touches DB surface. */
export function buildExpertRoles(
    changedFiles: FileChange[],
    opts: { includeQa?: boolean; includeDba?: boolean } = {},
): ExpertRole[] {
    const { includeQa = true, includeDba = true } = opts;
    const languages = detectPrLanguages(changedFiles);
    const languageRoles: ExpertRole[] = languages.map((lang) => ({
        name: `${lang} Specialist`,
        focus: `Idioms and gotchas SPECIFIC to ${lang} that a generalist reviewer without deep ${lang} experience would not recognize by pattern-matching alone — a stdlib/framework function that does something non-obvious given its name, a concurrency primitive used incorrectly for this language's memory/threading model, a language-specific footgun (mutable default, truthiness surprise, silent type coercion, error-shadowing). Only report when you can name the SPECIFIC ${lang} behavior that makes it wrong — not a generic "this looks risky".`,
    }));
    const fixed = includeQa
        ? FIXED_ROLES
        : FIXED_ROLES.filter((r) => r.name !== 'QA / Test Specialist');
    return [
        ...languageRoles,
        ...fixed,
        ...(includeDba && touchesDatabaseSurface(changedFiles)
            ? [DBA_ROLE]
            : []),
    ];
}

/** Step 1 prompt: one role investigates the WHOLE PR diff through its own
 *  lens only. Same diff the main pass saw — the lever here is focus, not
 *  new content. */
export function buildExpertRolePrompt(
    userPrompt: string,
    role: ExpertRole,
): string {
    return `${userPrompt}

<ExpertRole name="${role.name}">
  You are reviewing this PR as a ${role.name}. Read the diffs above with ONLY this lens:
  ${role.focus}

  Do not report anything outside this lens — another specialist covers the rest, and duplicate
  reports across lenses waste the panel's time. If nothing in this diff matches your lens, submit
  an empty suggestions array; do not stretch a weak observation to have something to say.
</ExpertRole>`;
}

/** Shared by both arbitration prompts below — renders every role's raw
 *  claims, including empty lenses (listed explicitly, not omitted), so the
 *  arbitrator can weigh silence as information rather than treat a missing
 *  section as "nothing to say about that". */
function formatPanelClaims(
    roleFindings: Array<{ role: string; suggestions: FinderSuggestion[] }>,
): string {
    return roleFindings
        .map(({ role, suggestions }) => {
            if (!suggestions.length) {
                return `### ${role}\n(found nothing in its lens)`;
            }
            const items = suggestions
                .map(
                    (s, i) =>
                        `  ${i + 1}. ${s.relevantFile} — ${s.suggestionContent.slice(0, 200)}`,
                )
                .join('\n');
            return `### ${role}\n${items}`;
        })
        .join('\n\n');
}

/** Step 2 prompt: shows every role's raw claims (including empty lenses, so
 *  the arbitrator can weigh silence as information) and asks for a single
 *  reconciled verdict per claim — the cross-examination step the evidence
 *  says actually matters, not just concatenating N opinions. */
export function buildExpertArbitrationPrompt(
    userPrompt: string,
    roleFindings: Array<{ role: string; suggestions: FinderSuggestion[] }>,
): string {
    const panel = formatPanelClaims(roleFindings);

    return `${userPrompt}

<ExpertPanelArbitration>
  A panel of specialists independently reviewed this PR, each through their own lens.
  Their raw claims:

${panel}

  Your job: reconcile the panel into a FINAL verdict.
    - A claim another specialist's expertise would corroborate (e.g. a security claim a database
      specialist's migration knowledge also supports) is stronger evidence, not proof by itself —
      verify it yourself against the code before keeping it.
    - A claim from one lens that another lens's expertise would specifically contradict (not just
      "seems fine") should be dropped — state which lens's reasoning overrides it.
    - Two claims describing the same underlying defect should be merged into one finding, not
      duplicated.
    - Silence from a lens (found nothing) is not evidence the concern is absent — do not treat an
      empty lens as confirmation the code is safe in that area.
  Use the tools to verify any claim you are not already certain of before keeping it. Submit only
  the FINAL, reconciled findings — not the raw panel transcript.
</ExpertPanelArbitration>`;
}

/** Skeptic variant of the arbitration step (A/B knob `recognitionPanel`,
 *  pairs with RECOGNITION_PANEL_ROLES): more adversarial than
 *  buildExpertArbitrationPrompt's neutral reconciliation. This session's
 *  ceiling audit found most missed goldens were cases where the finder READ
 *  the right code and still didn't connect it to a defect ("considered it,
 *  concluded safe") — the failure mode this specifically targets, by forcing
 *  an explicit counter-argument for every lens, silent or not, before any
 *  verdict. Runs even when EVERY role found nothing (unlike the neutral
 *  arbitration's skip-if-all-empty guard) — an all-silent panel is exactly
 *  the case this exists to challenge. MEASURED (20 PRs, as part of the
 *  recognitionPanel mechanism) and discarded — see
 *  RECOGNITION_PANEL_ROLES's doc for the result. The adversarial framing
 *  didn't outperform neutral arbitration in practice. */
export function buildSkepticArbitrationPrompt(
    userPrompt: string,
    roleFindings: Array<{ role: string; suggestions: FinderSuggestion[] }>,
): string {
    const panel = formatPanelClaims(roleFindings);

    return `${userPrompt}

<SkepticArbitration>
  A panel of specialists independently reviewed this PR, each through their own lens. Their
  raw claims (a lens that found nothing is listed as "found nothing in its lens"):

${panel}

  You are the panel's skeptic. Before finalizing anything, challenge EVERY lens above —
  including, and especially, the ones that found nothing. For each one, ask: what is the
  STRONGEST case that this lens missed something real? A lens finding nothing means it did
  not SEE a problem in its focus area, not that there isn't one — do not let silence stand
  unchallenged. Re-examine the diff yourself through each lens's focus before accepting its
  silence or its claim at face value.

  Then produce your FINAL verdict: only the defects you, after this challenge, can defend
  yourself — anchored to a changed line, concretely named. A claim corroborated across
  lenses is stronger signal, but a claim only one lens raised (or one YOU surfaced by
  challenging a silent lens) still counts if you can defend it. Discard anything — claimed
  or not — that does not survive your own challenge.
</SkepticArbitration>`;
}
