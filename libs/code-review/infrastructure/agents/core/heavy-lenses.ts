/**
 * Heavy mode's lenses (M3): nine narrow passes, one class of defect each, run
 * next to the generalist when a review asks for `--heavy`. Each lens gets the
 * whole diff, at most HEAVY_LENS_MAX_STEPS steps and at most
 * HEAVY_LENS_MAX_FINDINGS findings; what it finds joins the generalist's
 * findings before verify, under the lens's own label.
 *
 * The nine and their prompts are the measured M3 configuration (#1821): the
 * generalist plus these lenses scored above the generalist alone on the gold
 * set, on every model measured. Item text is read out of
 * V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT, so the two never drift apart.
 */
import {
    CLAUDE_ONE_PROBLEM_REINFORCEMENT,
    ONE_PROBLEM_RULE,
} from '@libs/code-review/infrastructure/agents/prompts/one-problem-rule';
import { normalizeFilenameForTier } from '@libs/code-review/infrastructure/agents/collaborators/context-fit-planner';
import type { AgentLoopInput } from '@libs/code-review/infrastructure/agents/review-agent.contract';
import { V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT } from '@libs/common/utils/codeReview/v2Defaults';

/** The lens's whole system prompt: everything it needs is in its user prompt,
 *  and the generalist's would put "review this PR broadly" under a one-class
 *  assignment. */
export const HEAVY_LENS_SYSTEM_PROMPT = `You are a specialist code reviewer. You are given one class of defect to look for in one pull request, and the tools to investigate it. Investigate with the tools before deciding, and answer by calling the submitResult tool.`;

/** Without a sandbox there is nothing to investigate with: the lens reads the
 *  diff alone, as the generalist does in that case. */
export const HEAVY_LENS_SELF_CONTAINED_SYSTEM_PROMPT = `You are a specialist code reviewer. You are given one class of defect to look for in one pull request. You have no tools and no access to the repository: you see only the diff. Report only what the visible lines prove, and answer by calling the submitResult tool.`;

/** Steps per lens: the "3" in M3. */
export const HEAVY_LENS_MAX_STEPS = 3;

/** Findings per lens. */
export const HEAVY_LENS_MAX_FINDINGS = 4;

export type HeavyLensLabel = 'bug' | 'security' | 'performance';

export interface HeavyLens {
    id: string;
    /** Fixed: every finding of the lens takes it, whatever label the model
     *  wrote, since the lens only looks for its own class. */
    label: HeavyLensLabel;
    /** One line naming the assignment, used in <Role>. */
    assignment: string;
    /** Prefixes of items pulled verbatim from the shared category text. */
    items: string[];
    /** Items that exist only here. */
    extraItems?: string[];
    /** Class-specific example for the `reasoning` field. */
    reasoningExample: string;
}
const CONTRACT_CHANGE = `- Contract change not followed through: The change altered something callers depend on — a function became asynchronous, a return type became nullable or changed shape, a parameter was added/removed/reordered, a field disappeared from a response, an interface gained a required member. Reconstruct what the symbol looked like BEFORE this change and check every consumer against the new shape. Report the consumer that was not updated, anchoring the finding to the changed line.
  This includes a change to the BEHAVIOUR contract, not only to the type: an operation that was best-effort and now fails the request, work that was asynchronous or fire-and-forget and now blocks the caller, an error that was swallowed and now propagates, a fallback that used to cover a case and no longer does. Reconstruct what the caller could previously count on and name what it loses — reporting only the new cost (latency, an extra query) misses the point when the real change is that the operation can now refuse.`;
const CHANGED_FILES_DISAGREE = `- Two changed files that do not agree: this change touches more than one file, and two of the hunks are about the same symbol — the same function, constant, key, route, field, metric name or class. Neither hunk is wrong when you read it alone; the defect is that one side does not hold up what the other side assumes. Three shapes to look for, all of them the same question:
  - PRODUCER AND CONSUMER: a value is built in one hunk and consumed in another under a different premise — a percentage passed where the consumer needs explicit dimensions, a datetime placed in a dict the other side serializes to JSON, a full URL passed where the receiver compares it against an origin, a return type the caller's base class does not accept.
  - CONTRACT DECLARED ON THE OTHER SIDE: the call is only wrong against a declaration living in the other changed file — a callee that can return null, a required parameter on the signature, a base class or interface the subclass must satisfy.
  - GENERATOR AND VALIDATOR: one hunk produces and the other checks, and they disagree — a route supplying one parameter key while the handler reads another, values generated lowercase and compared case-sensitively, an enrichment removed in one middleware and never re-added by the one that replaced it.
  METHOD: list the symbols that appear in hunks of two DIFFERENT files. For each, read both sides and state what one produces and what the other requires. Report only when they genuinely conflict, and anchor the finding to the side a developer would have to change. Do NOT report a defect visible inside a single hunk — other reviewers own that; yours is the disagreement BETWEEN two of them.`;
const CROSS_REFERENCE = `- Cross-reference inconsistency: Two places that must agree and don't — a metric tagged with one name at emit and another at query, a constant or key written differently at the write site and the read site, a validator checking a different field than the writer sets, arguments passed in one order and consumed in another. Neither side is wrong in isolation; the defect is the disagreement. Compare every pair of sites in this change that share a name, key, tag, or ordering.`;
const INDEX_AND_ORDER = `- Index, slice and ordering assumptions: Boundary arithmetic on substrings, slices, ranges and pagination whose indices do not match the layout the code describes; comparisons whose extracted segment is off by one or inverted; code that assumes an iteration, lookup or zip preserves input order when the structure gives no such guarantee (dict/map values, concurrent results, unordered collections). Verify the arithmetic against a concrete example and check whether the ordering is actually guaranteed.`;
const NAME_DOC_MISMATCH = `- Name and documentation mismatch: an identifier, comment, docstring, error message or changelog entry that this change made untrue — a function renamed but still described by the old comment, a flag whose name states the opposite of what it now controls, a parameter documented with a default the code no longer uses, a doc block describing a return shape the function stopped producing. The name and the prose are part of the contract a caller reads; report the disagreement between them and the code, anchored to the changed line.`;
const TEST_DOES_NOT_VERIFY = `- Test that does not verify what it claims: a test whose body would still pass if the behaviour it names were broken. Ask the falsification question on every test file this PR touches — if the defect this test exists to catch were reintroduced, would this test fail? Report it when the answer is no. The ways that answer turns out to be no:
  - It exercises the wrong target: a different HTTP verb, route, method or overload than the code under test handles; an argument order, fixture or payload that never reaches the branch the test is named after.
  - The assertion is too loose to fail: catching a base exception where the code raises a specific subclass, asserting truthiness or non-null on something that is always set, comparing a value against itself, or an assertion placed after an early return.
  - A mock, patch or fixture neutralises the thing under test: time.sleep patched out and then relied on to wait, the function under test stubbed by an autouse fixture, a spy asserted against instead of the real effect.
  - It synchronises on time instead of on a condition: a fixed sleep, a deadline, or an assertion that fires before the thread, process or async task it is about has finished. It passes on a fast machine and races on a slow one.
  - The name or docstring disagrees with the body: a case called empty_array that passes an empty dict, a typo in the test name that hides it from a name-filtered run, a docstring describing an assertion the body does not make.
  Read the test against the implementation it covers, never on its own — the defect is almost always the disagreement between the two.`;
const I18N_LOCALE = `- Localisation and user-facing content: a string shown to a user that bypasses the translation mechanism the surrounding code uses, an interpolation whose placeholders do not match the keys the translators receive, a locale file changed on one side only, a format (date, number, currency, pluralisation) hard-coded to one locale, or content that stops being escaped on its way to the user. Compare against how the neighbouring strings in the same file are handled.`;
const DEAD_COMPUTATION_EXT = `- Dead computation (extended): the existing item covers a value computed and then not used. It also covers TWO NEARLY IDENTICAL NAMES IN THE SAME SCOPE where the code goes on using the original instead of the enriched or transformed one (\`log\` vs \`d.Log\`, \`ctx\` vs \`reqCtx\`), and it covers A BRANCH THAT CANNOT EXECUTE — an \`else if\` whose condition is already excluded by the branch above it, or a final \`else\` made unreachable because the function it tests never returns that value. Trace the assignment and the branch conditions rather than reading them as written.`;
const WRONG_RESULTS_EXT = `- Wrong results (extended): the error code, the HTTP status and the message text are OUTPUT, exactly like a returned value. A handler that answers 404 where the resource exists but the caller lacks permission, a message naming a different field than the one that failed validation, or a code that tells the client to retry something that can never succeed are all wrong results, even when the happy path is correct.`;
const EXECUTION_BREAKS_EXT = `- Execution breaks (extended): the SERIALISATION BOUNDARY is where a value that was fine in memory raises — a datetime, Decimal, set, or custom object placed into a payload that will be JSON-encoded, a field that becomes NaN or Infinity, a type the queue's encoder has no rule for. The exception surfaces at the encode call, not at the line that produced the value, so check what happens to every new field on its way out.`;
const STATE_CORRUPTION_EXT = `- State corruption (extended): a CACHE is state, and it corrupts the same way — an error result, an empty fallback or a partially built object written into the cache under the key of the real answer, so every later reader is served the failure. Check what gets stored on the failure path, not only on the success path.`;

export const HEAVY_LENSES: HeavyLens[] = [
    {
        id: 'says-one-thing-does-another',
        label: 'bug',
        assignment:
            'what the code declares, measures or names versus what it actually uses',
        items: [
            'Dead computation',
            'Incorrect measurements',
            'Wrong results',
            'Logic errors',
        ],
        extraItems: [CROSS_REFERENCE, DEAD_COMPUTATION_EXT, WRONG_RESULTS_EXT],
        reasoningExample:
            "The metric is emitted with the tag 'shard' at writer.go:31 and queried with 'shards' at dashboard.go:12 — both added in this diff. The panel will read nothing. Reported.",
    },
    {
        id: 'text-that-ships',
        label: 'bug',
        assignment:
            'text that reaches a person — names, comments, messages, translations — disagreeing with the code',
        items: [],
        extraItems: [NAME_DOC_MISMATCH, I18N_LOCALE],
        reasoningExample:
            'The flag added at config.ts:12 is named disableRetry but the branch at client.ts:88 enables retries when it is true. Read both: the name states the opposite of the behaviour. Reported.',
    },
    {
        id: 'invalid-state-and-concurrency',
        label: 'bug',
        assignment:
            'the declared constraint and the path that breaks it, including interleaving',
        items: [
            'Execution breaks',
            'State corruption',
            'Invariant violations',
            'Race conditions',
        ],
        extraItems: [EXECUTION_BREAKS_EXT, STATE_CORRUPTION_EXT],
        reasoningExample:
            'CreateDevice counts then inserts. Grepped TagDevice(, found the caller at impl.go:155. Two concurrent requests both pass the count check before either inserts, and there is no unique constraint. Reported.',
    },
    {
        id: 'value-boundary-and-position',
        label: 'bug',
        assignment:
            'what the code assumes about a value at its boundaries and positions',
        items: [
            'Conditional validation errors',
            'Floating-point equality in critical operations',
        ],
        extraItems: [INDEX_AND_ORDER],
        reasoningExample:
            "The prefix check at token.ts:61 reads substring(4,6), but the comment and the writer at token.ts:20 place the shortcut at indices 5-6. Worked through 'abc:XY1234': the check compares the wrong two characters. Reported.",
    },
    {
        id: 'secret-and-identity',
        label: 'security',
        assignment:
            'comparisons, normalisation and derivation involving secrets or identity',
        items: [
            'Timing attacks',
            'Case-sensitivity bypass',
            'Crypto issues',
            'Insecure fallback values',
        ],
        reasoningExample:
            'The new token check at auth.ts:40 compares with ===. Read the surrounding helper: no constant-time path anywhere in the file. The old code used timingSafeEqual, removed in this diff. Reported.',
    },
    {
        id: 'contract-not-followed',
        label: 'bug',
        assignment:
            'a changed contract that a consumer was not updated to match',
        items: [],
        extraItems: [CONTRACT_CHANGE],
        reasoningExample:
            'findMembers() gained async in this diff. Grepped findMembers(, found controller.ts:48 using the result directly with no await — it now holds a Promise. Reported, anchored to the changed signature.',
    },
    {
        id: 'test-does-not-verify',
        label: 'bug',
        assignment:
            'tests changed by this PR that would still pass if the behaviour they cover were broken',
        items: [],
        extraItems: [TEST_DOES_NOT_VERIFY],
        reasoningExample:
            'test_consumer.py waits with time.sleep(1) at line 88, but time.sleep is patched to a no-op by the autouse fixture at line 31. Read both: the wait returns immediately, so the assertion at line 90 runs before the flusher has processed anything and would pass with the flusher removed entirely. Reported.',
    },
    {
        id: 'data-exposure',
        label: 'security',
        assignment:
            'what leaves in the response, the log and the error message',
        items: ['Data exposure'],
        reasoningExample:
            'The new catch block at service.ts:77 logs the whole request object, which carries the Authorization header set at middleware.ts:14. Reported.',
    },
    {
        id: 'changed-files-disagree',
        label: 'bug',
        assignment:
            "two hunks in different changed files that do not hold up each other's assumptions",
        items: [],
        extraItems: [CHANGED_FILES_DISAGREE],
        reasoningExample:
            'routes.rb:212 declares the member route, so Rails supplies params[:id]; groups_controller.rb:48, also in this diff, reads params.require(:group_id). Both hunks are new. The action raises ParameterMissing on every request. Reported, anchored to the controller.',
    },
];

/** Pulls an item out of the shared category text by its prefix. A prefix that
 *  stops matching fails loudly instead of leaving an empty focus block. */
function itemByPrefix(prefix: string): string {
    for (const text of Object.values(V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT)) {
        for (const line of String(text).split('\n')) {
            const t = line.trim();
            if (t.startsWith(`- ${prefix}`)) return t;
        }
    }
    throw new Error(
        `heavy lenses: no detection item starts with "${prefix}" — it was renamed or removed in v2Defaults`,
    );
}

export function focusBlockFor(lens: HeavyLens): string {
    return [...lens.items.map(itemByPrefix), ...(lens.extraItems ?? [])].join(
        '\n',
    );
}

/** The lenses a review runs: those whose category the team has on. */
export function heavyLensesFor(allowedLabels?: readonly string[]): HeavyLens[] {
    if (!allowedLabels?.length) return HEAVY_LENSES;
    return HEAVY_LENSES.filter((l) => allowedLabels.includes(l.label));
}

/** The diff every lens reads: each changed file's patch under a header with
 *  its status and coverage tier. */
export function heavyLensDiff(
    changedFiles: AgentLoopInput['changedFiles'],
    fileTiers?: AgentLoopInput['fileTiers'],
): string {
    return (changedFiles ?? [])
        .map((f) => {
            const diff = (f?.patchWithLinesStr ?? f?.patch ?? '').trim();
            if (!diff) return '';
            const tier = fileTiers?.get(
                normalizeFilenameForTier(String(f?.filename ?? '')),
            );
            const mark =
                tier === 'critical' ? ' [CRITICAL]' : tier ? ` [${tier}]` : '';
            return `--- ${f?.filename} (${f?.status})${mark} ---\n${diff}`;
        })
        .filter(Boolean)
        .join('\n\n');
}

const SILENCE = `  Most pull requests contain no defect of any single class. If this one contains
  none of yours, submit an empty suggestions array — that is a valid answer, and
  a forced finding costs more than a silent pass.`;

const CEILING = `  AT MOST ${HEAVY_LENS_MAX_FINDINGS}. Submit no more than ${HEAVY_LENS_MAX_FINDINGS} suggestions. This is a ceiling, never a
  quota: zero is the ordinary answer and one is common. Do not add a finding to
  fill the space. ORDER the suggestions from the one you are surest of to the one
  you are least sure of — the first entry must be your strongest.`;

/**
 * One lens's prompt. The diff goes FIRST: the lenses run together on the same
 * pull request, and prefix caching only matches from the start of the
 * message, so the shared diff is cached once instead of paid per lens.
 */
export function buildHeavyLensPrompt(
    lens: HeavyLens,
    diffText: string,
    /** Claude also gets the one-problem reinforcement (#1821). */
    claudeSafeWording = false,
    /** No sandbox: nothing to grep, so the evidence rule points at the diff. */
    selfContained = false,
): string {
    const evidenceRule = selfContained
        ? `You cannot see the repository, only the diff. Never claim something is
  missing, undefined, not imported, or has the wrong signature unless the diff
  itself shows it; a defect that depends on code you cannot see is not reported.`
        : `Never claim something is missing, undefined, not imported, or does not exist
  without first using grep to confirm. Never claim a method has the wrong
  signature without first reading its definition.`;
    return `<Diffs>
${diffText}
</Diffs>

<Role>
  You are a code reviewer with ONE assignment on this pull request: ${lens.assignment}.
  You are not reviewing it broadly — other reviewers cover the rest. Look for the
  class of defect defined below and nothing else. A defect outside that class is
  real, but it is not yours to report.
</Role>

<DetectionFocus>
${focusBlockFor(lens)}
</DetectionFocus>

<Stance>
  A change being intentional does not make it correct. Conclude "safe" only after
  a real attempt to break it came up empty — "it looks correct" is not a verdict;
  "I traced X and confirmed Y holds" is.

  Report any defect of your assigned class that the changed code makes you
  suspect; dismiss only what you can explain WHY it cannot fail. Root cause must
  be in lines added or modified by this PR — report a pre-existing issue only if
  this change makes it worse or newly reachable.

  The diff above is the whole pull request. Your assignment is the block above —
  read the diff against it, not broadly.
</Stance>

<OutputFormat>
  Report by calling the submitResult tool with this shape:

\`\`\`json
{
  "reasoning": "REQUIRED, never empty — what you traced and why you reported or dismissed. Example: '${lens.reasoningExample}'",
  "suggestions": [
    {
      "label": "${lens.label}",
      "relevantFile": "path/to/file.ext",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "suggestionContent": "the ONE problem: what is wrong and why it matters"
    }
  ]
}
\`\`\`

  Anchor relevantLinesStart/End to the lines this PR changed — that is the fix site.

  ${claudeSafeWording ? `${ONE_PROBLEM_RULE} ${CLAUDE_ONE_PROBLEM_REINFORCEMENT}` : ONE_PROBLEM_RULE}

  "reasoning" is REQUIRED and is never empty, including when you report nothing:
  name what you read, what you checked it against, and why you concluded the
  change is safe for your class. A submission with an empty reasoning is not a
  verdict — it is an unanswered assignment, and it makes the pass impossible to
  review afterwards.

  If your own analysis concludes a concrete defect is real, it MUST become an
  entry in "suggestions" — writing "reported" in the reasoning without a matching
  entry means the finding is LOST.

  ${evidenceRule}

${SILENCE}

${CEILING}
</OutputFormat>`;
}
