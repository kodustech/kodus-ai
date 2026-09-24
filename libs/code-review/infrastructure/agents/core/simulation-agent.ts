/**
 * code-review (domain) — SIMULATION pass: execute the change in your head
 * instead of scanning it for known shapes.
 *
 * Why this is not a sixteenth micro-agent. Every agent we have works the same
 * way underneath: it carries a list of defect classes and looks for something
 * that matches one. Measured on the 30-PR light set that procedure recovers
 * 50.5% of the goldens, and fifteen variations of it — more agents, smaller
 * diff slices, higher reasoning effort, plan+shard, dedicated prompts — all
 * land on the same goldens. Coverage is not the gap: all 39 goldens missed on
 * the small PRs map onto a detection item that already exists, several of them
 * named almost verbatim (Case-sensitivity bypass, Insecure fallback values,
 * Cross-reference inconsistency). One item was written word for word from the
 * golden it was meant to catch, and the agent carrying it still missed it.
 *
 * What the missed goldens share is not a category, it is a PROCEDURE. Read
 * them and the same sentence keeps appearing: what if the org has no child
 * teams, what if the id does not exist, what if the request is nil, what if
 * the deadline elapses mid-loop, what happens when this value is serialised.
 * Each one needs a concrete state chosen and walked through the changed lines.
 * None of them can be recognised by pattern.
 *
 * The false positives are the mirror image. What the agents over-report is
 * exactly what pattern matching finds without executing anything: a missing
 * import, a button without a type, a label without htmlFor. At 28.9% precision
 * the model is not silent — it is answering a different question than the one
 * the goldens ask.
 *
 * So this prompt deliberately contains NO list of defect classes. Naming them
 * is what pulls the model back into recognition. It gives a procedure instead,
 * and makes the report conditional on having run it: a finding is admissible
 * only when a walk through concrete state ends somewhere wrong.
 *
 * NOT YET MEASURED. Written from the 39 missed goldens as evidence of what the
 * procedure must cover, but deliberately generic — it names no defect and
 * fits no specific bug in the corpus. Whether it generates anything the other
 * fifteen do not is the open question.
 */
import type { MicroAgentGroup } from './micro-agents';

export const SIMULATION_SYSTEM_PROMPT =
    'You are a code reviewer who finds defects by executing changed code in your head against concrete inputs, not by recognising patterns. You investigate with the tools before deciding, and answer by calling the submitResult tool.';

/**
 * The state list is the load-bearing part. Left to itself the model enumerates
 * categories ("edge cases", "error handling") and moves on; naming the actual
 * situations forces a value it has to carry through the code. Every entry here
 * is the shape of a golden the harness has missed, generalised away from the
 * case it came from.
 */
export function buildSimulationPrompt(
    diffText: string,
    /** What other passes RAISED on this PR, before any filtering. Measured
     *  reason for passing it: run alone, this pass found 21 goldens and 19 were
     *  already found by the class agents — 90% of its true positives were
     *  re-discovery.
     *
     *  Pre-reducer candidates, not posted findings: the reducer runs once at
     *  the end over everything, so at the moment this pass executes nothing has
     *  been filtered. Feeding it the posted set would describe a state that
     *  never exists in production.
     *
     *  Which is why the block calls them claims and says most are unverified —
     *  at 28.9% precision, roughly two thirds of that list is wrong, and a pass
     *  that reasons FROM it inherits the error. Framed as covered ground rather
     *  than a forbidden list for the same reason as always: the cheapest way to
     *  manufacture false positives is to make the model feel it must come back
     *  with something. */
    alreadyFound?: Array<{ file?: string; line?: number; summary?: string }>,
    /** Blob <CallGraph>, logo abaixo do diff — mesma posicao que nos
     *  microagentes, pelo mesmo motivo de cache. Opt-in. */
    callGraph?: string,
): string {
    const covered = alreadyFound?.length
        ? `
<AlreadyRaised>
  Other reviewers have gone over this pull request and RAISED the items below.
  Nothing has filtered them yet, so treat them as claims, not as facts: some
  are wrong, and none has been verified. Do not reason from them, do not try to
  confirm or refute them, and do not re-raise them — a walk that ends on one of
  these costs you a walk you could have run somewhere else.

${alreadyFound
      .map(
          (f) =>
              `  - ${f.file ?? '?'}${f.line ? `:${f.line}` : ''} — ${String(f.summary ?? '').slice(0, 160)}`,
      )
      .join('\n')}

  Their presence says nothing about the rest of the change, and their absence
  from a file says nothing either. Walk your states as you would have anyway;
  if every walk you run ends correctly, an empty submission is still the right
  answer.
</AlreadyRaised>
`
        : '';

    const graphBlock = callGraph?.trim() ? `\n${callGraph.trim()}\n` : '';

    return `<Diffs>
${diffText}
</Diffs>
${graphBlock}${covered}
<Role>
  You are not scanning this change for known kinds of bug. Other reviewers do
  that, and they have already done it. Your job is to RUN this code in your
  head against concrete situations and report the runs that end somewhere wrong.

  A defect you recognised by its shape, without walking it, is not yours to
  report — it has already been looked for.
</Role>

<Procedure>
  Work through these steps in order. The output format below requires the trace,
  so skipping to the answer will not produce a valid submission.

  STEP 1 — ENTRY POINTS.
  List every function, method, handler, route, job or migration this diff added
  or changed. For each one, use the tools to find who calls it and with what.

  STEP 2 — STATES.
  For each entry point, write down the concrete situations a real caller can
  put it in. Not categories — actual values and actual conditions. Work through
  this list and keep the ones that can occur here, saying in one clause why you
  discarded the rest:
    - the collection is empty; the collection has exactly one element
    - the lookup finds nothing: the id does not exist, was deleted, or belongs
      to someone else
    - the field is missing from the payload; the field is present and null
    - the number is zero, is negative, or sits exactly on the boundary the code
      compares against
    - this is the first run: no prior row, no cache entry, no file, nothing stored
    - two callers arrive at the same moment, or the same caller retries
    - the operation half-succeeded: it wrote one thing and failed the next
    - the value travels onward afterwards — it gets serialised, queued, cached,
      logged, compared, or returned across a boundary
    - the caller is an older version that has not been updated for this change

  STEP 3 — WALK.
  Take each state and carry it through the changed lines, one line at a time.
  Read the definitions you need with the tools; do not assume what a function
  does. Write the walk down: the state you started with, the lines it passes
  through in order, and what the caller is left holding at the end.

  STEP 4 — BEFORE AND AFTER.
  For each entry point, say what a caller received BEFORE this diff and what it
  receives now. Name anything it loses: a guarantee, a fallback, a value that
  was always set, an error that used to be swallowed, work that used to happen
  in the background.

  STEP 5 — REPORT.
  Report only the walks whose ending is wrong. Every other walk stays in your
  reasoning as evidence that you ran it.
</Procedure>

<WhatCountsAsWrong>
  A walk ends wrong when the caller is left with an answer that is not true, an
  exception it had no way to expect, silence where it needed to know something
  failed, an error where the operation actually succeeded, or a guarantee it
  was relying on that no longer holds.

  "This could be a problem" is not a wrong ending. "I started from X, went
  through lines N to M, and the caller receives Y, which is wrong because Z" is.
</WhatCountsAsWrong>

<DoNotReport>
  These are handled elsewhere and reporting them here costs a real finding:
    - names, comments, docstrings, formatting, or anything cosmetic
    - accessibility attributes and markup conventions
    - a symbol you believe is missing, undefined or not imported, unless you
      confirmed it with grep — asserting this without checking is the single
      most common wrong answer on this task
    - defensive validation you cannot tie to a concrete caller that violates it
    - anything you did not actually walk
</DoNotReport>

<OutputFormat>
  Report by calling the submitResult tool with this shape:

\`\`\`json
{
  "reasoning": "REQUIRED, never empty — the walks you ran. Example: 'Entry point: CreateOrUpdateDevice, called from TagDevice at impl.go:155. States kept: count already at the limit; row missing. Walked the limit case: line 109 counts, line 115 compares, line 116 calls updateDevice, line 95 sees rowsAffected 0 and returns ErrDeviceLimitReached. Walked the missing-row case: the WHERE at line 78 matches nothing, same line 95, same error — so a caller with no stored device is told the limit was reached. Reported. Also walked the concurrent case: two callers both pass line 115 before either inserts; no unique constraint found by grep, reported separately.'",
  "suggestions": [
    {
      "label": "bug",
      "relevantFile": "path/to/file.ext",
      "language": "the file language",
      "suggestionContent": "WALK: the state you started from and the path it took. WHAT: what the caller ends up with. WHY: why that is wrong.",
      "existingCode": "the lines the walk ends on",
      "improvedCode": "fixed code (only if the fix is clear from what you read)",
      "oneSentenceSummary": "Brief summary",
      "reason": "REQUIRED when the schema asks for it — the same walk you put in suggestionContent, stated as a trace: state you started from, the lines in order with file:line, and the ending. If you cannot write it, you did not walk it.",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low",
      "confidence": 8
    }
  ]
}
\`\`\`

  Anchor relevantLinesStart/End to the lines this PR changed — that is the fix site.

  Assign confidence by how much of the walk you verified by reading code rather
  than assuming:
    9-10: you read every definition the walk passes through
    7-8:  you read the changed code and the caller, but assumed one intermediate
    5-6:  the walk is plausible but you did not read the other side
    1-4:  you did not really walk it

  If every walk you ran ended correctly, submit an empty suggestions array and
  say in the reasoning which states you walked and why each one was fine. That
  is a valid and useful answer; a forced finding costs more than a silent pass.
</OutputFormat>`;
}

/** Shaped like the other passes so the adapter can treat it uniformly; the
 *  items list is empty on purpose — this agent has no categories. */
export const SIMULATION_AGENT: MicroAgentGroup = {
    id: 'simulate-the-change',
    label: 'bug',
    assignment: 'running the changed code in your head against concrete states',
    items: [],
    extraItems: [],
    reasoningExample: '',
};
