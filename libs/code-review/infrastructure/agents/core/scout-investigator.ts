/**
 * code-review (domain) — scout → deep-investigator: a cheap ONE-SHOT pass that
 * flags SUSPICIOUS spots (not findings) across the whole diff, followed by one
 * full agent-loop investigation pass PER flag, each with full tools and a
 * budget dedicated to that one spot.
 *
 * Distinct from every other extra pass built today: those all add MORE LLM
 * VOICES over the same uniformly-divided attention (another file, another
 * role, another vote). This changes WHERE attention concentrates instead — a
 * cheap wide scan casts suspicion broadly, then depth is spent only where the
 * scan flagged something, rather than split evenly across the whole diff. The
 * paper backing this session's diagnosis names diff size as the #1 bottleneck
 * (F1 drops 15× from small to large diffs) — this targets that directly by
 * narrowing WHERE the expensive reasoning goes, not by adding another pass
 * that re-reads everything.
 *
 * The scout does NOT try to name a defect — that is the exact recognition
 * failure this session diagnosed (the model reads the right line and doesn't
 * connect it to a mechanism). Asking it to also nail the mechanism would just
 * pay for a cheaper copy of the same failure. It only has to notice something
 * changed in a way worth a closer look; the deep-investigator pass, with full
 * tool budget concentrated on ONE spot instead of divided across the whole
 * diff, does the harder job of naming what's actually wrong.
 */
import { z } from 'zod';
import { LLM } from '@libs/llm/llm';
import type { NormalizedModel } from '@libs/llm/byok-config';

/** Hard cap independent of prompt compliance — a scout that flags everything
 *  is not a scout, it is atomic-hunks with extra words, and pays that cost. */
export const MAX_SCOUT_FLAGS = 5;

/** Sentinel cap meaning "no number in the prompt" (A/B knob: RECALL_SCOUT_CAP=0).
 *  The scout is asked for the spots worth investigating by OBJECTIVE instead of
 *  by count. Exploratory: every measured cap above 5 has been worse (7 → F1
 *  0.358, 10 → worse still), and each extra flag costs one full investigator
 *  pass, so an uncapped run has no cost ceiling by construction. */
export const UNCAPPED_SCOUT = 0;

/** Resample knobs (opt-in, see finder.agent.ts's scout block). Measured
 *  today: raising ONE round's cap from 5 to 10 tanked both recall and
 *  precision (more flags per round dilutes signal, isn't free breadth) — so
 *  resampling stays SEQUENTIAL and CONTEXT-AWARE (round N sees round 1..N-1's
 *  flags, asked for OTHER spots, same shape as synthesis-rescue) with a
 *  TIGHTER per-round cap, rather than one round asking for more. */
export const SCOUT_RESAMPLE_ROUNDS = 3;
/** Shared by runScoutResample (every round, including round 1) AND
 *  runScoutSecondRound (its one follow-up round only — round 1 there keeps
 *  MAX_SCOUT_FLAGS unchanged, see runScoutSecondRound's doc). */
export const SCOUT_ROUND_CAP = 3;

export interface ScoutFlag {
    relevantFile: string;
    hint: string;
    /** Approximate line the hint is anchored to, when the scout can point to
     *  one — optional because not every flag reduces to a single line (e.g. "no
     *  pagination added" spans the whole function). Only asked for when
     *  buildScoutPrompt's `requestLine` is true (A/B knob RECALL_SCOUT_LINE_HINT
     *  in finder.agent.ts). Root cause this targets: a 30-PR trace audit found
     *  investigators that reached the RIGHT FILE but never engaged the golden
     *  bug's exact code at all (drifted to a different part of the same file) —
     *  a file-only hint doesn't anchor WHERE in the file to look. */
    line?: number;
    /** Which scout raised this — undefined for the single-scout (pre-category)
     *  path, kept for back-compat with existing callers/tests. */
    category?: ScoutCategory;
}

export type ScoutCategory = 'bug' | 'performance' | 'security';

const SCOUT_CATEGORY_FOCUS: Record<ScoutCategory, string> = {
    bug: 'Correctness only: logic errors, wrong state transitions, broken contracts, wrong caller/callee assumptions, lost side effects. Not performance, not security.',
    performance:
        'Performance only: queries/network calls inside a loop, missing pagination/limits on data that can grow unbounded, blocking calls on a hot/async path, algorithmic complexity that got worse. Not correctness, not security.',
    security:
        'Security only: untrusted input reaching a sink (command, URL fetch, file path, query, deserialization), broken auth/access-control boundaries, secrets or tokens handled unsafely, trust assumptions that changed. Not correctness, not performance.',
};

const SCOUT_SCHEMA = z.object({
    flags: z.array(
        z.object({
            relevantFile: z.string(),
            hint: z.string(),
            line: z.number().optional(),
        }),
    ),
});

/** Wraps the SAME diffs/context the main pass sees (userPrompt already has
 *  them) with a scout-specific task. The main pass's own Rules/OutputFormat
 *  text riding along in userPrompt is harmless noise here — LLM.run's schema
 *  shapes the actual output via structured tool-calling, not the free text.
 *  `category` narrows the lens (three focused scouts instead of one general
 *  one) — omit for the single, general-purpose scout. */
export function buildScoutPrompt(
    userPrompt: string,
    category?: ScoutCategory,
    cap: number = MAX_SCOUT_FLAGS,
    requestLine = false,
    minimalBase = false,
    hypothesisDriven = false,
): string {
    const lens = category
        ? `\n\n  Your lens for this pass: ${SCOUT_CATEGORY_FOCUS[category]}`
        : '';
    const lineAsk = requestLine
        ? ' Include the line number in the DIFF (the new/changed line, not the ' +
          'file overall) your suspicion is anchored to — "somewhere in this file" ' +
          "is not enough for the investigator to know where to start."
        : '';
    // "Ignore every rule above" only makes sense when there IS a rules block
    // above (the default: userPrompt is the full investigation prompt). With
    // scoutDedicatedPrompt, `userPrompt` here is already diff-only — nothing
    // to ignore, so the line would be dead instruction text.
    const ignorePriorRules = minimalBase
        ? ''
        : 'Ignore every rule and output format above. ';
    // hypothesisDriven (A/B knob, see finder.agent.ts) inverts the default
    // instruction below: instead of a vague "worth a look" flag, name a
    // SPECIFIC, falsifiable hypothesis for what's wrong. Untested design
    // assumption until now — this session's ceiling audit found the
    // dominant miss pattern was the investigator reading the right code and
    // not connecting it to a defect, not under-investigation. Pushing the
    // connection earlier, while attention is cheap and undivided, may (or
    // may not) reduce that failure instead of just moving it downstream.
    const flagInstruction = hypothesisDriven
        ? `Flag the ${cap} spots (fewer if there is less to say) MOST worth a deep,
  focused look. Unlike a vague "this looks risky" note, each flag must state a SPECIFIC,
  falsifiable HYPOTHESIS for what's wrong — name the exact failure mode you suspect (e.g.
  "returns null here but the caller assumes non-null", "the wrong variable is returned —
  the modified one, not the original", "this check uses AND where the sibling method uses
  OR"). You do not need to have proven it — the investigator's job is to confirm or refute
  your specific hypothesis — but it must be a concrete claim, not just a location worth
  checking.`
        : cap === UNCAPPED_SCOUT
          ? `Flag the spots MOST worth a deep, focused look — the places where
  something looks off enough to deserve investigation, and only those; not everything that
  looks even slightly off. A flag names WHAT changed and WHY it's worth checking, in one
  sentence — it does not need to be provable, name the exact failure, or trace
  callers/callees.`
          : `Flag the ${cap} spots (fewer if there is less to say) MOST
  worth a deep, focused look — not everything that looks even slightly off. A flag names
  WHAT changed and WHY it's worth checking, in one sentence — it does not need to be
  provable, name the exact failure, or trace callers/callees.`;
    return `${userPrompt}

<ScoutTask>
  ${ignorePriorRules}You are NOT investigating, confirming, or
  writing a finding — a separate pass with full tool access does that afterward.

  Skim the diffs. ${flagInstruction} Ground every flag in
  something concrete in the diff — a value that changed origin, a check that moved, a
  condition that got wider or narrower, a call that now runs somewhere new — not a vague
  "this looks risky".${lineAsk}${lens}

  If nothing in this diff raises real suspicion, return an empty list. An empty list is
  a valid, honest answer — it is not a failure to find something.
</ScoutTask>`;
}

/** Round 2/3 of the resample: shows what earlier rounds already flagged and
 *  asks for OTHER spots, not paraphrases — the same "re-think from what's
 *  already there, don't restate" shape as the main pass's synthesis-rescue,
 *  which was measured (today, smaller model) as the single most productive
 *  extra pass. Blind resampling (no context) was NOT chosen here: heavy's own
 *  data shows blind re-runs mostly reproduce paraphrases of the same finding,
 *  which dedup then collapses away — this spends the round asking for
 *  something a paraphrase can't be. */
export function buildScoutFollowUpPrompt(
    userPrompt: string,
    alreadyFlagged: ScoutFlag[],
    cap: number,
): string {
    const already = alreadyFlagged.length
        ? alreadyFlagged
              .map((f) => `  - ${f.relevantFile} — ${f.hint}`)
              .join('\n')
        : '  (nothing flagged yet)';
    return `${userPrompt}

<ScoutTask>
  Ignore every rule and output format above. You are NOT investigating, confirming, or
  writing a finding — a separate pass with full tool access does that afterward.

  Earlier passes already flagged:
${already}

  Skim the diffs again. Flag up to ${cap} OTHER spots worth a deep, focused look — spots
  the list above does NOT already cover. Do not restate, rephrase, or narrow one of the
  above into "another" flag; that wastes an investigator's dedicated budget on a duplicate.
  Ground every flag in something concrete in the diff, same as before.

  If there is nothing else worth flagging, return an empty list. An empty list is a valid,
  honest answer — it is not a failure to find something.
</ScoutTask>`;
}

/** One-shot structured call — no tools, no agent loop. This is the "cheap"
 *  half of the mechanism: short output, no investigation, so it costs a
 *  fraction of even a single agent-loop pass. Mirrors recoverFindingsFromProse
 *  (same LLM.run primitive, same best-effort-never-breaks-the-review posture).
 *
 *  `reasoningEffort` (A/B knob `scoutThinking`, see review-agent.contract.ts):
 *  the scout runs with reasoning OFF by default — RECALL_REASONING_EFFORT
 *  (used to test the investigator at higher effort) does NOT reach this call,
 *  confirmed by its logs staying "none" through those runs; this param exists
 *  to set it explicitly and independently. Hypothesis going in: the
 *  investigator's effort-hurts-it finding might not transfer here, since the
 *  scout only notices (no conclusion to rationalize). MEASURED (8 PRs) and
 *  discarded: WORSE on every axis — F1 0.469→0.379, and a direct before/after
 *  diff of which goldens were found showed 0 gained, 3 goldens that were
 *  previously found now missed. Not a recall/precision tradeoff, a straight
 *  regression. Kept as a flag (off), not a validated config. */
export async function runScout(
    prompt: string,
    byokConfig: NormalizedModel | undefined,
    organizationId: string | undefined,
    usageRunName?: string,
    category?: ScoutCategory,
    cap: number = MAX_SCOUT_FLAGS,
    reasoningEffort?: string,
): Promise<ScoutFlag[]> {
    try {
        const result = await LLM.run({
            byokConfig,
            schema: SCOUT_SCHEMA,
            user: prompt,
            runName: usageRunName
                ? `${usageRunName}-scout${category ? `-${category}` : ''}`
                : `code-review-scout${category ? `-${category}` : ''}`,
            organizationId,
            ...(reasoningEffort
                ? { providerOptions: { openai: { reasoningEffort } } }
                : {}),
        });
        const flags = (result.flags as ScoutFlag[] | undefined) ?? [];
        // UNCAPPED_SCOUT keeps every flag — `slice(0, 0)` would drop them all,
        // turning "no cap" into "no scout".
        return (cap === UNCAPPED_SCOUT ? flags : flags.slice(0, cap)).map((f) =>
            category ? { ...f, category } : f,
        );
    } catch {
        // Best-effort: a broken scout must degrade to "no flags", never break
        // the review the main pass is already running independently.
        return [];
    }
}

/** Runs SCOUT_RESAMPLE_ROUNDS sequential rounds, each context-aware of the
 *  prior rounds' flags and capped at SCOUT_ROUND_CAP — round 2/3 see what's
 *  already flagged and are told to find OTHER spots, not paraphrase them.
 *  Sequential (not Promise.all): round N's prompt depends on round N-1's
 *  output, so there is nothing to parallelize here — the parallelism in this
 *  mechanism is all in the investigator passes that consume the final list. */
export async function runScoutResample(
    runScoutFn: (
        prompt: string,
        category?: ScoutCategory,
        cap?: number,
    ) => Promise<ScoutFlag[]>,
    userPrompt: string,
): Promise<ScoutFlag[]> {
    let all: ScoutFlag[] = [];
    for (let round = 0; round < SCOUT_RESAMPLE_ROUNDS; round++) {
        const prompt =
            round === 0
                ? buildScoutPrompt(userPrompt, undefined, SCOUT_ROUND_CAP)
                : buildScoutFollowUpPrompt(userPrompt, all, SCOUT_ROUND_CAP);
        // eslint-disable-next-line no-await-in-loop
        const roundFlags = await runScoutFn(
            prompt,
            undefined,
            SCOUT_ROUND_CAP,
        );
        all = all.concat(roundFlags);
    }
    return all;
}

/** Runs the scout in exactly TWO rounds instead of one: round 1 UNCHANGED
 *  from the validated single-scout config (buildScoutPrompt, cap
 *  MAX_SCOUT_FLAGS — same as when scoutInvestigator runs with neither this
 *  nor scoutResample set), then ONE follow-up round capped at
 *  SCOUT_ROUND_CAP via buildScoutFollowUpPrompt (shown round 1's flags, asked
 *  for OTHER spots, empty list explicitly permitted as "a valid, honest
 *  answer").
 *
 *  Isolates the two variables runScoutResample conflated when it was measured
 *  negative (5 PRs: recall 51%→25%, precision 77%→17%, cost 331→531 calls):
 *  (a) shrinking round 1's cap from 5 to 3, and (b) running 2 extra rounds
 *  instead of 1. This changes NEITHER (a) — round 1 keeps cap 5 — and only
 *  adds ONE extra round, not two. A/B knob (see finder.agent.ts's
 *  scoutSecondRound) — not yet measured. */
export async function runScoutSecondRound(
    runScoutFn: (
        prompt: string,
        category?: ScoutCategory,
        cap?: number,
    ) => Promise<ScoutFlag[]>,
    userPrompt: string,
): Promise<ScoutFlag[]> {
    const round1 = await runScoutFn(
        buildScoutPrompt(userPrompt, undefined, MAX_SCOUT_FLAGS),
        undefined,
        MAX_SCOUT_FLAGS,
    );
    const round2 = await runScoutFn(
        buildScoutFollowUpPrompt(userPrompt, round1, SCOUT_ROUND_CAP),
        undefined,
        SCOUT_ROUND_CAP,
    );
    return round1.concat(round2);
}

/** Cap per category for runScoutByCategory — kept separate from
 *  SCOUT_ROUND_CAP (same value, different mechanism) so the two can be tuned
 *  independently later. 3 categories × 3 = up to 9 flags total, vs 5 for the
 *  single general scout — an intentional, not yet validated, increase. */
export const CATEGORY_SCOUT_CAP = 3;

/** Three PARALLEL scouts, one per category, each with its OWN dedicated base
 *  (diff + only THAT category's BUG/PERFORMANCE/SECURITY definitions — see
 *  finder.agent.ts's scoutByCategory / core-agent-loop.adapter.ts's
 *  categoryDiffPrompt) instead of one general scout.
 *
 *  A prior attempt at "3 category scouts" (referenced in finder.agent.ts's
 *  scout-dispatch comment) was measured on 5 PRs and tanked both recall
 *  (51%→11%) and precision (77%→19%) — but that test was confounded: all 3
 *  scouts still received the FULL generalist userPrompt (every category's
 *  rules, all of Rules/OutputFormat/CoverageContract), with only a one-line
 *  SCOUT_CATEGORY_FOCUS sentence layered on top to say which lens to use.
 *  Never a real per-category prompt, and never re-run on 30 PRs. This
 *  version gives each scout ONLY its own category's detection text — a
 *  genuinely isolated test of the same idea. MEASURED (20 PRs, same set as
 *  scoutCalibratedPrompt for a direct comparison) and discarded: F1 0.418 vs
 *  0.456, at higher cost (more flags → more investigator passes). Splitting
 *  by category dilutes signal the same way every other scout-widening
 *  attempt did — not free breadth. Kept as a flag, not a validated config. */
export async function runScoutByCategory(
    runScoutFn: (
        prompt: string,
        category?: ScoutCategory,
        cap?: number,
    ) => Promise<ScoutFlag[]>,
    basesByCategory: Record<ScoutCategory, string>,
    cap: number = CATEGORY_SCOUT_CAP,
    requestLine = false,
): Promise<ScoutFlag[]> {
    const categories: ScoutCategory[] = ['bug', 'performance', 'security'];
    const results = await Promise.all(
        categories.map((category) =>
            runScoutFn(
                buildScoutPrompt(
                    basesByCategory[category],
                    category,
                    cap,
                    requestLine,
                    true,
                ),
                category,
                cap,
            ),
        ),
    );
    return results.flat();
}

/** Groups flags by relevantFile, preserving first-seen file order and each
 *  file's flags in their original order — for `investigatorGroupByFile` (see
 *  buildMultiFlagInvestigatorPrompt's doc). A file with only one flag still
 *  gets its own single-element group, so callers can treat group.length as
 *  the switch between the single-flag and multi-flag prompt. */
export function groupFlagsByFile(flags: ScoutFlag[]): ScoutFlag[][] {
    const order: string[] = [];
    const byFile = new Map<string, ScoutFlag[]>();
    for (const flag of flags) {
        if (!byFile.has(flag.relevantFile)) {
            byFile.set(flag.relevantFile, []);
            order.push(flag.relevantFile);
        }
        byFile.get(flag.relevantFile)!.push(flag);
    }
    return order.map((file) => byFile.get(file)!);
}

/** The deep pass: full tool budget dedicated to ONE flagged spot. Unlike
 *  critical-file (diff injected, deterministic), this one investigates with
 *  tools like the main pass does — the scout gave a FILE + a REASON, not a
 *  diff, and re-plumbing changedFiles lookups into this pass for one more
 *  injection point isn't worth it when the tools already do this job. */
/** Shared by buildInvestigatorPrompt and buildMultiFlagInvestigatorPrompt —
 *  the two anchoring traps apply regardless of how many flags a pass got. */
const INVESTIGATOR_TRAPS_TEXT = `  One specific trap: if the change affects a PUBLIC method/interface/contract (its
  documented behavior, its return type's nullability, an API other code depends on),
  do NOT clear it just because the one caller you traced happens to tolerate the change.
  A public contract is used by callers you cannot all enumerate — the broken contract
  itself is the defect, independent of whether your one traced caller survives it.
  Only clear a contract change as safe if you verified EVERY caller, or the contract's
  own documentation was updated to match.

  A second trap: tracing a path and confirming it does not crash is not the same as
  confirming it is correct. A caller can tolerate a value without that value satisfying
  the method's own documented contract — and the diff alone will not show you that
  contract, because the interface/superclass declaring it is usually a file the diff
  never touches. Concretely: if the changed method overrides or implements an
  interface/abstract method, use grep/findFile to locate that declaration and read its
  Javadoc/docstring/signature BEFORE concluding — do not settle for reasoning about
  what a caller happens to tolerate as a substitute for reading the declared contract
  itself. Likewise, a guard or early return added on one path can silently skip a
  downstream call some input previously reached, without ever crashing — trace
  what stops running for that input, not just what still works.`;

export function buildInvestigatorPrompt(
    userPrompt: string,
    flag: ScoutFlag,
    hypothesisDriven = false,
): string {
    const anchor =
        flag.line != null
            ? ` (around line ${flag.line} in the diff — start there, not a general skim of the file)`
            : '';
    // hypothesisDriven (see buildScoutPrompt's doc): the flag IS a specific,
    // falsifiable claim, not a vague "worth a look" — frame the task as
    // confirm-or-refute THIS, not open-ended investigation of the area.
    const framing = hypothesisDriven
        ? `A preliminary scan proposed a SPECIFIC HYPOTHESIS for a defect here${anchor}:
  ${flag.hint}

  Your job: CONFIRM or REFUTE this exact hypothesis — not a general audit of the file.
  Read what you need to verify it, trace the specific callers/callees the hypothesis
  depends on. You have the full toolset and no other spot to split attention with.`
        : `A preliminary scan flagged this spot as worth a deep, focused look${anchor}:
  ${flag.hint}

  Investigate it thoroughly: read the file, trace callers/callees, verify every
  assumption before concluding. You have the full toolset and no other spot to split
  attention with — use that budget here.`;
    return `${userPrompt}

<FlaggedForInvestigation file="${flag.relevantFile}">
  ${framing}

  Report ONLY a defect you can name concretely, anchored to a changed line in
  ${flag.relevantFile}. If your investigation clears the suspicion — the code is correct,
  or the concern does not hold up — submit an empty suggestions array. Clearing a false
  alarm is a valid, useful outcome; do not stretch a weak signal into a finding because
  you were asked to look.

${INVESTIGATOR_TRAPS_TEXT}
</FlaggedForInvestigation>`;
}

/** Cost experiment (A/B knob `investigatorGroupByFile`, see finder.agent.ts):
 *  when N>=2 scout flags land on the SAME file, one pass investigates ALL of
 *  them together instead of N separate full agent-loop passes each re-reading
 *  the same file from scratch. Files with a single flag are UNCHANGED — this
 *  only applies where flags already share a file, so it doesn't touch the
 *  scoutInvestigator/secondLookSameFile-validated single-flag path at all.
 *
 *  Distinct from the combined-lens mechanisms this session measured negative
 *  (scoutByCategory, recognitionPanel — which merged DIFFERENT files/topics,
 *  diluting cross-file/cross-topic attention): this merges flags that were
 *  already going to read the SAME file's context, which secondLookSameFile's
 *  validated result suggests is a reasonable place to reuse one investigation
 *  for more than one bug. The "investigate every one with equal depth"
 *  instruction below is a request, not an architectural guarantee — whether
 *  the model actually honors it on flag 2+ is exactly what this experiment
 *  measures. Not yet measured. */
export function buildMultiFlagInvestigatorPrompt(
    userPrompt: string,
    flags: ScoutFlag[],
): string {
    const file = flags[0].relevantFile;
    const items = flags
        .map((f, i) => {
            const anchor =
                f.line != null ? ` (around line ${f.line} in the diff)` : '';
            return `  ${i + 1}. ${f.hint}${anchor}`;
        })
        .join('\n');
    return `${userPrompt}

<FlaggedForInvestigation file="${file}">
  A preliminary scan flagged ${flags.length} SEPARATE, independent spots worth a deep,
  focused look in this file:
${items}

  Each numbered item above is a DIFFERENT suspicion, unrelated to the others unless stated
  otherwise. Investigate EVERY one with the same depth and rigor you would give it if it
  were the only flag — confirming or clearing one does not excuse skimming the rest, and a
  later item is not less important than the first. You have the full toolset and no other
  file to split attention with; use that budget across all of them.

  Report ONLY defects you can name concretely, anchored to a changed line in ${file} — one
  entry per confirmed suspicion, fewer if some don't hold up. If your investigation clears
  ALL of them, submit an empty suggestions array. Clearing a false alarm is a valid, useful
  outcome; do not stretch a weak signal into a finding because you were asked to look.

${INVESTIGATOR_TRAPS_TEXT}
</FlaggedForInvestigation>`;
}

/** One follow-up per investigator pass that cleared its flag (empty findings)
 *  after writing real reasoning — feeds that reasoning back and asks it to
 *  argue the opposite case before finalizing. Root cause this targets: a
 *  30-PR trace audit of missed goldens the investigator DID reach found that
 *  ~55% were not blind spots — the pass explicitly considered the exact
 *  concern and talked itself out of it. Deliberately narrower than "force
 *  every flag to produce a finding": it only reopens a dismissal the pass
 *  itself already engaged with, using its own words as the seed, and it can
 *  still end in an empty array — this is not a quota. */
export function buildInvestigatorChallengePrompt(
    userPrompt: string,
    flag: ScoutFlag,
    priorReasoning: string,
): string {
    return `${userPrompt}

<ChallengeYourOwnDismissal file="${flag.relevantFile}">
  You already investigated this spot once and did not report a defect. Your own
  reasoning from that pass:

  """
  ${priorReasoning}
  """

  Before finalizing, argue the OPPOSITE case: what would have to be true for the
  concern you dismissed to actually be a real bug? Re-check the SPECIFIC assumption
  your dismissal rested on — do not re-run a generic investigation of the whole file,
  challenge the exact reasoning above.

  If your dismissal holds up under this challenge, submit an empty suggestions array
  again — that is still a valid, honest outcome. Only report a defect you can now name
  concretely, anchored to a changed line in ${flag.relevantFile}, that your prior pass
  missed or got wrong.
</ChallengeYourOwnDismissal>`;
}

/** One follow-up per investigator pass that cleared its flag (0 findings) after
 *  actually looking (>0 tool calls) — reuses that pass's OWN tool-call trail
 *  instead of re-exploring, and asks about a DIFFERENT concern in the same
 *  file. Distinct from buildInvestigatorChallengePrompt: challenge re-litigates
 *  the SAME suspicion the flag named; this drops that suspicion and asks
 *  whether the file has an UNRELATED defect the narrow hint never pointed at.
 *  Root cause this targets: a 30-PR trace audit of investigator passes that
 *  reached the right file but still missed the golden bug found most (7/9)
 *  never engaged the golden's specific code at all — not because they gave up
 *  early, but because the task as framed ("confirm or clear THIS suspicion")
 *  never asked about anything else in the file.
 *
 *  MEASURED on a 5-PR sample first — read as a clear loss (recall 51%→41%,
 *  precision 77%→34%). That reading was wrong: the 5-PR set's OWN baseline was
 *  itself an unusually favorable subset (well above the 30-PR baseline), so
 *  the comparison was noise, not signal. Re-measured on the full 30-PR set:
 *  recall 32.4%→40.8% (+8.4pp), precision 43.8%→44.2% (flat/up), F1
 *  0.372→0.424 — the best result of this investigation, at +18% tool-call
 *  cost. Validated config, not a discard.
 *
 *  `forceReport` (A/B knob `secondLookForceReport`): on the current best
 *  config (scoutCalibratedPrompt), 61% of secondLook calls (25/41 on 30 PRs)
 *  return an empty array — the honest-empty escape hatch this prompt
 *  deliberately offers. Forcing a report removes that escape, asking for the
 *  single most plausible candidate instead. Unlike every "force more output"
 *  attempt this investigation tried (cap 10, resample, secondLookAlways,
 *  3-category-scouts — all diluted precision), this doesn't add MORE calls,
 *  it changes the instruction on an EXISTING one — a different mechanism, not
 *  yet known to fail the same way. Not yet measured. */
export function buildInvestigatorSecondLookPrompt(
    userPrompt: string,
    flag: ScoutFlag,
    toolCallSummary: string,
    forceReport = false,
): string {
    const closing = forceReport
        ? `  You must report at least one concrete candidate — pick the single MOST plausible
  defect you can point to in ${flag.relevantFile}, even if you are not fully certain.
  Anchor it to a changed line and be honest about your uncertainty in the reasoning and
  confidence score; a low-confidence real candidate is still more useful than silence.`
        : `  If there is nothing else, submit an empty suggestions array. That is a valid, honest
  outcome — do not invent a second issue just because you were asked to look again.`;
    return `${userPrompt}

<SecondLookSameFile file="${flag.relevantFile}">
  You already investigated this file for one specific suspicion:
  ${flag.hint}

  What you already looked at there (a recap, not a request to re-read):
  ${toolCallSummary || 'No tool calls captured.'}

  Forget that original suspicion now. Based on everything you already saw above, is
  there any OTHER concrete defect in ${flag.relevantFile} — unrelated to the flagged
  concern — anchored to a line this diff changed? Use tools again only if you need to
  check something you have not already seen above.

${closing}
</SecondLookSameFile>`;
}

/** Independent full pass, minimal-but-guided prompt — a different STYLE, not
 *  a different architecture. Reworked 2026-09-16 from the original bare
 *  "senior engineer, find real bugs" text, guided by the precision research
 *  round: shape-based category definitions instead of vulnerability names
 *  (few-shot/specific examples measured WORSE precision than a basic prompt
 *  in the industry FP study — lists anchor the model and it misses what is
 *  not on the list), plus a concrete-MECHANISM bar per finding (the light
 *  form of proof obligation). The category shapes reuse the scout's
 *  validated lens phrasing (SCOUT_CATEGORY_FOCUS above), not a new taxonomy.
 *  Only hard rule kept: anchor to a changed line — every "loosen the prompt"
 *  experiment this session lost precision the moment that rule went away.
 *
 *  First attempt at this A/B knob passed the FULL rule-laden userPrompt as
 *  `base` and only told the model to "ignore" it — still the same prompt
 *  underneath, not a genuinely different style. `minimalBase` (paired with
 *  finder.agent.ts's `freeformBasePrompt`, built the same way as the scout's
 *  `scoutBasePrompt`) drops the now-dead "ignore every rule above" line the
 *  same way buildScoutPrompt's minimalBase does. A/B knob `freeformPass`. */
export function buildFreeformPrompt(
    base: string,
    minimalBase = false,
): string {
    const ignorePriorRules = minimalBase
        ? ''
        : 'Ignore every rule and output format above except the anchoring rule below.\n\n  ';
    return `${base}

<FreeformTask>
  ${ignorePriorRules}You are a senior engineer reviewing this PR. Investigate whatever you need
  with the tools — read callers, contracts, whatever the change touches.

  Look for three things, in this order of importance:
  1. Logic/correctness bugs — behavior the change gets wrong: broken contracts,
     wrong state transitions, lost side effects, wrong caller assumptions.
  2. Security flaws — untrusted input reaching a sensitive sink (query, command,
     URL fetch, file path, deserialization), broken auth/permission boundaries,
     trust assumptions this change altered.
  3. Performance regressions — queries or network calls inside a loop, missing
     limits/pagination on data that can grow unbounded, blocking work on a hot
     path, algorithmic complexity that got worse.

  Only report findings where you can name the concrete MECHANISM: what state or
  input triggers the problem, and what goes wrong. If you cannot name the
  mechanism, do not report it.

  Every suggestion must be anchored to a line this diff added or changed.
  Nothing found = empty suggestions array; that is a valid answer.
</FreeformTask>`;
}

/** TEST 1 (A/B knob `scoutVerdict`): the scout's flags become a MANDATORY
 *  checklist appended to the generalist's own prompt, instead of fanning out
 *  one investigator per flag.
 *
 *  Why this shape: measured across 5 models, fanning out investigators only
 *  paid off on DeepSeek (F1 0.448 vs 0.388 generalist); on every OpenAI model
 *  it raised cost ~4x while F1 fell (Sol 0.389 -> 0.347). Meanwhile the
 *  frontier models' real bottleneck is recall-by-conservatism — they
 *  investigate well and then decline to report (the minimal-prompt run on
 *  terra produced 3 findings across 30 PRs at 100% precision). A flag the
 *  model MUST rule on is a closed question ("is this a defect: yes/no"),
 *  which sidesteps the open judgment call ("is this worth reporting?") the
 *  conservative model keeps answering with silence. One pass, one model, the
 *  full diff still in context — so cross-file reasoning is not fragmented the
 *  way per-flag investigators fragment it. Not yet measured. */
export function buildScoutVerdictBlock(flags: ScoutFlag[]): string {
    if (!flags.length) return '';
    const items = flags
        .map((f, i) => {
            const line = f.line != null ? ` (around line ${f.line})` : '';
            return `  ${i + 1}. ${f.relevantFile}${line} — ${f.hint}`;
        })
        .join('\n');
    return `

<FlaggedSpots>
  A preliminary scan flagged the spots below. You MUST rule on EVERY one of
  them before you finalize — none may be left unaddressed.

${items}

  For each: investigate it with the tools, then either report a concrete defect
  (if the suspicion holds) or state in your reasoning why it does not hold.
  Ruling a spot out is a useful answer; leaving it unexamined is not.

  These are leads, not limits: findings outside this list are just as welcome.
</FlaggedSpots>`;
}

/** TEST 2 (A/B knob `adversarial`): invert the task from reviewing to BREAKING.
 *  Instead of "find bugs" (an open judgment the conservative frontier model
 *  answers with silence), ask for the concrete input/state that makes the
 *  changed code misbehave. What the model manages to break IS the finding —
 *  no "is this worth reporting?" gate in between. Anchoring to a changed line
 *  is kept: every loosen-the-prompt experiment this session lost precision the
 *  moment that rule went away. Not yet measured. */
export function buildAdversarialPrompt(
    base: string,
    minimalBase = false,
): string {
    const ignorePriorRules = minimalBase
        ? ''
        : 'Ignore every rule and output format above except the anchoring rule below.\n\n  ';
    return `${base}

<BreakIt>
  ${ignorePriorRules}You are trying to BREAK this change, not to review it.

  For the code this diff adds or modifies, find the concrete input, state or
  sequence of events that makes it behave wrong: crash, return the wrong
  value, skip work it used to do, corrupt data, leak access, or fall over
  under load. Use the tools to check what the code depends on and who calls
  it — an attack is only real if the path to it is real.

  Work through the changed code hunk by hunk. For each one ask: what would I
  send to make this fail? What did this stop doing that something else still
  expects? What does it assume about its inputs that nobody enforces?

  Report each break you find: the trigger (input/state/sequence) and what goes
  wrong as a result. A break you can trigger is a finding — you do not need to
  judge whether it is "worth reporting", only whether it is real.

  Every finding must be anchored to a line this diff added or changed.
</BreakIt>`;
}
