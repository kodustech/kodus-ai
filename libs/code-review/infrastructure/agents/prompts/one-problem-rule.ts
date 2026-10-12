/**
 * #1821: every finding must describe exactly one problem. The base rule is
 * enough for DeepSeek and GPT (>90% single-problem suggestions on the 30-PR
 * set); Claude keeps appending a second defect with "also", so it gets the
 * reinforcement as well.
 */

export const ONE_PROBLEM_RULE =
    'One problem per suggestion. Each entry in "suggestions" describes exactly ONE defect: one root cause and the failure it causes. If the same code has two problems (for example a missing validation and a wrong argument), report them as two separate suggestions, each anchored to its own lines. Never combine several problems in one suggestion.';

export const CLAUDE_ONE_PROBLEM_REINFORCEMENT =
    'The fix you describe is for that defect only. Do not append anything else to a suggestion: no second issue, no side note, no extra recommendation, no "also check" or "also confirm", no "the same applies to" another place. Before submitting, reread every suggestionContent: if it names two things that would be fixed separately, split it into two entries or drop the secondary one. Two defects in the same function or the same lines are still two suggestions. Example of what NOT to submit, as one entry: "The cache key omits the tenant id, so one tenant reads another tenant\'s entries. The TTL is also never set, so entries never expire." That is two problems: submit one entry for the missing tenant id and a separate entry for the missing TTL. A second defect introduced with "also", "additionally" or "in addition" is the sign that you are combining two problems. Count problems by fixes, not by lines: if correcting it takes two independent edits, even on the same line (for example a wrong time unit AND a missing null check), those are two suggestions. The first sentence names the one defect; every later sentence must be about that same defect. Keep each suggestionContent to at most three sentences. The fix covers that defect only: do not add hardening, fallbacks or error handling that the defect itself does not need.';

/** Claude only: the reinforcement right after every occurrence of the base rule. */
export function withClaudeOneProblem(prompt: string): string {
    return prompt.split(ONE_PROBLEM_RULE).join(`${ONE_PROBLEM_RULE} ${CLAUDE_ONE_PROBLEM_REINFORCEMENT}`);
}

/** The category writing policy (WHAT/WHY/HOW), as tightened for Claude. */
const WRITING_POLICY_SWAPS: ReadonlyArray<readonly [string, string]> = [
    [
        'Each finding must be technical, direct, and verifiable. Structure every suggestionContent as:',
        'Each finding must be technical, direct, and verifiable, and cover ONE problem only. Structure every suggestionContent as:',
    ],
    ...(['correct', 'secure', 'optimized'] as const).map(
        (kind) =>
            [
                `3. HOW: a concrete fix only if the ${kind} implementation is clear from the code you read — omit if speculative`,
                `3. HOW: a concrete fix for that one problem only, if the ${kind} implementation is clear from the code you read — omit if speculative`,
            ] as const,
    ),
];

export function withClaudeWritingPolicy(systemPrompt: string): string {
    return WRITING_POLICY_SWAPS.reduce((p, [from, to]) => p.split(from).join(to), systemPrompt);
}

/** Muse: besides combining problems, it submits entries that report no defect
 *  ("checked, it is correct"). The examples are invented code, never benchmark PRs. */
export const MUSE_ONE_PROBLEM_REINFORCEMENT = `Every entry in "suggestions" must report a defect that requires a code change. Do not submit an entry to say that you checked something and it is correct, that the code is safe or already handled, that no change is needed, or to describe what the code does. Those notes belong in "reasoning", not in "suggestions". If you found nothing that needs fixing, submit an empty suggestions array.

Each suggestion describes ONE defect and the fix for that defect only. If you found two defects, even in the same lines or caused by the same change, write two suggestions. Do not append a second problem with "also", and do not add extra recommendations (hardening, try/catch, rate limiting, refactors) that the defect itself does not need.

WRONG — two problems in one entry:
"\`parseLimit\` calls Number(req.query.limit) with no check, so a non-numeric value becomes NaN and the query returns every row. Also, the result of \`cache.get\` is never awaited, so the handler returns before the cached page is read."
RIGHT — two entries: one for the NaN limit returning every row, one for the missing await on \`cache.get\`.

WRONG — one change, two defects with different fixes:
"The retry loop now uses \`attempts <= maxAttempts\`, so it runs one extra time, and the backoff is \`attempts * 1000\` seconds instead of milliseconds, so retries wait a thousand times longer than intended."
RIGHT — two entries: one for the extra iteration, one for the backoff unit.

WRONG — a defect plus unrelated recommendations:
"\`deleteAccount\` skips the ownership check when \`req.user.isAdmin\` is undefined, so any logged-in user can delete another user's account. Also wrap the handler in try/catch and add rate limiting."
RIGHT — one entry about the skipped ownership check only.

RIGHT — single-problem suggestions:
"\`formatPrice\` divides \`cents\` by 10 instead of 100, so every price is shown ten times higher. Divide by 100."
"\`logout\` deletes the session row but never clears the \`sid\` cookie, so the browser keeps sending a session id the server no longer knows and the user lands on the error page. Clear the cookie on logout."`;

/** Muse only: the reinforcement right after every occurrence of the base rule. */
export function withMuseOneProblem(prompt: string): string {
    return prompt.split(ONE_PROBLEM_RULE).join(`${ONE_PROBLEM_RULE}\n\n${MUSE_ONE_PROBLEM_REINFORCEMENT}\n`);
}
