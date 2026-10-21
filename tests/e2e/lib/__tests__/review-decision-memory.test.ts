import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
    extractSuggestedCode,
    isContradictionComment,
    isOrderingContradictionComment,
    isCapContradictionComment,
    isCollisionContradictionComment,
} from "../../scenarios/review-decision-memory.js";

const MARKER = "<!-- kody-codereview -->";
const badge = (sev: string) =>
    `![kody code-review](https://img.shields.io/badge/kody-code--review-312B4B) ![Bug](https://img.shields.io/badge/Bug-B71C1C) ![${sev}](https://img.shields.io/badge/severity_level-${sev}-6B6B92)`;

// Captured verbatim from a real Kody comment on a live run of this scenario
// (kodustech/testing-repo#42) — the actual shape extractSuggestedCode has to
// parse, not an idealized approximation of it.
const REAL_KODY_COMMENT = `${badge("critical")}


getUserName dereferences user.name even though the parameter type permits null, so a null argument throws a TypeError despite the type contract advertising null as valid. Guard the input by returning user ? user.name : ''.

\`\`\`undefined
export function getUserName(user: { name: string } | null): string {
    return user ? user.name : '';
}
\`\`\`



<details>

<summary>Prompt for LLM</summary>

\`\`\`

File src/e2e-decision-memory-fixture.ts:

Line 1 to 3:

getUserName dereferences user.name even though the parameter type permits null, so a null argument throws a TypeError despite the type contract advertising null as valid. Guard the input by returning user ? user.name : ''.

Suggested Code:

export function getUserName(user: { name: string } | null): string {
    return user ? user.name : '';
}

\`\`\`

</details>


<sub>Talk to Kody by mentioning @kody</sub>

${MARKER}`;

test("extractSuggestedCode: parses the real Kody comment shape (first fence, not the <details> duplicate)", () => {
    assert.equal(
        extractSuggestedCode(REAL_KODY_COMMENT),
        "export function getUserName(user: { name: string } | null): string {\n    return user ? user.name : '';\n}\n",
    );
});

test("extractSuggestedCode: returns null when there is no fenced code block", () => {
    assert.equal(
        extractSuggestedCode(`${badge("low")}\n${MARKER}\nConsider adding a unit test for this function.`),
        null,
    );
});

test("extractSuggestedCode: returns null for an empty fence", () => {
    assert.equal(extractSuggestedCode("```\n\n```"), null);
});

test("extractSuggestedCode: works with a language-tagged fence", () => {
    assert.equal(
        extractSuggestedCode("Some text\n```ts\nconst x = 1;\n```\nmore text"),
        "const x = 1;\n",
    );
});

test("flags a comment that asks to remove the null check", () => {
    const body = `${badge("medium")}\n${MARKER}\nThis null check looks redundant now — you can remove the check and return user.name directly.`;
    assert.equal(isContradictionComment(body), true);
});

test("flags a comment calling the guard unnecessary", () => {
    const body = `${badge("low")}\n${MARKER}\nThe undefined check here is unnecessary since the caller already validates user.`;
    assert.equal(isContradictionComment(body), true);
});

test("flags a comment suggesting simplification by dropping the guard", () => {
    const body = `${badge("low")}\n${MARKER}\nYou could simplify this function by removing the extra branch.`;
    assert.equal(isContradictionComment(body), true);
});

// The trap: a comment that legitimately mentions "check" in an unrelated
// sense (code review jargon, not "remove this specific null check") must
// NOT be flagged — otherwise the assertion would false-positive on totally
// unrelated review chatter and the scenario would never pass.
test("does not flag an unrelated comment that happens to contain 'check'", () => {
    const body = `${badge("low")}\n${MARKER}\nPlease check the naming convention used for this helper — 'getUserName' should probably be 'resolveUserName'.`;
    assert.equal(isContradictionComment(body), false);
});

test("does not flag a comment that AGREES with the applied fix", () => {
    const body = `${badge("low")}\n${MARKER}\nGood, the null check added here correctly guards against a missing user.`;
    assert.equal(isContradictionComment(body), false);
});

test("does not flag an empty or unrelated finding on a different concern", () => {
    assert.equal(
        isContradictionComment(
            `${badge("medium")}\n${MARKER}\nConsider adding a unit test for this function.`,
        ),
        false,
    );
});

test("does not flag a comment that merely describes the already-applied fix", () => {
    const body = `${badge("low")}\n${MARKER}\nRemoving the null check fixed the crash — nice catch.`;
    assert.equal(isContradictionComment(body), false);
});

test("does not flag a comment referencing the removal in past tense without a directive", () => {
    const body = `${badge("low")}\n${MARKER}\nThe null check you removed earlier now returns an empty string instead of throwing, which matches the new contract.`;
    assert.equal(isContradictionComment(body), false);
});

test("flags the literal reversal phrasing", () => {
    const body = `${badge("low")}\n${MARKER}\nJust return user.name directly here, the guard adds no value.`;
    assert.equal(isContradictionComment(body), true);
});

// isOrderingContradictionComment — the revoke-before-issue fixture's
// contradiction detector (modeled on a real production pattern found during
// investigation, not naming any internal system).

test("ordering: flags a directive to revoke before issuing", () => {
    const body = `${badge("medium")}\n${MARKER}\nYou should revoke the previous token before issuing the new one — that way a stale token never lingers.`;
    assert.equal(isOrderingContradictionComment(body), true);
});

test("ordering: flags 'revoke first' phrasing", () => {
    const body = `${badge("low")}\n${MARKER}\nRevoke the old token first, then issue the replacement.`;
    assert.equal(isOrderingContradictionComment(body), true);
});

test("ordering: flags 'move revoke above' phrasing", () => {
    const body = `${badge("low")}\n${MARKER}\nMove the revoke call above the issue call.`;
    assert.equal(isOrderingContradictionComment(body), true);
});

test("ordering: flags 'issue after revoke' phrasing", () => {
    const body = `${badge("low")}\n${MARKER}\nThe token should be issued after the previous one is revoked, not before.`;
    assert.equal(isOrderingContradictionComment(body), true);
});

test("ordering: does not flag a comment agreeing with the applied (issue-first) fix", () => {
    const body = `${badge("low")}\n${MARKER}\nGood, issuing the new token before revoking the old one avoids the lockout.`;
    assert.equal(isOrderingContradictionComment(body), false);
});

test("ordering: does not flag an unrelated finding on the same file", () => {
    const body = `${badge("low")}\n${MARKER}\nConsider renaming 'store' to 'tokenStore' for clarity.`;
    assert.equal(isOrderingContradictionComment(body), false);
});

test("ordering: does not flag a comment merely describing the fix in past tense", () => {
    const body = `${badge("low")}\n${MARKER}\nIssuing the token before revoking the old one fixed the lockout — nice catch.`;
    assert.equal(isOrderingContradictionComment(body), false);
});

// isCapContradictionComment — the unbounded-fanout-cap fixture's
// contradiction detector (modeled on a real production pattern found during
// investigation, not naming any internal system).

test("cap: flags a directive to remove the cap", () => {
    const body = `${badge("medium")}\n${MARKER}\nYou should remove the cap here so every job gets a status.`;
    assert.equal(isCapContradictionComment(body), true);
});

test("cap: flags 'without a limit' phrasing", () => {
    const body = `${badge("low")}\n${MARKER}\nThis should run without a limit so no job is silently skipped.`;
    assert.equal(isCapContradictionComment(body), true);
});

test("cap: flags 'no cap' phrasing", () => {
    const body = `${badge("low")}\n${MARKER}\nThere should be no cap on jobIds — every id needs a status.`;
    assert.equal(isCapContradictionComment(body), true);
});

test("cap: flags 'dropping the limit' phrasing", () => {
    const body = `${badge("low")}\n${MARKER}\nConsider dropping the limit entirely.`;
    assert.equal(isCapContradictionComment(body), true);
});

test("cap: does not flag a comment agreeing with the applied fix", () => {
    const body = `${badge("low")}\n${MARKER}\nGood, capping jobIds avoids an unbounded fan-out here.`;
    assert.equal(isCapContradictionComment(body), false);
});

test("cap: does not flag an unrelated finding on the same file", () => {
    const body = `${badge("low")}\n${MARKER}\nConsider adding a type annotation for the return value.`;
    assert.equal(isCapContradictionComment(body), false);
});

test("cap: does not flag a comment merely describing the fix in past tense", () => {
    const body = `${badge("low")}\n${MARKER}\nCapping jobIds here fixed the fan-out — nice catch.`;
    assert.equal(isCapContradictionComment(body), false);
});

// isCollisionContradictionComment — the cross-tenant-cache-key-collision
// fixture's contradiction detector (modeled on a real production pattern
// found during investigation, not naming any internal system).

test("collision: flags a directive to revert the tenant-scoped fallback", () => {
    const body = `${badge("medium")}\n${MARKER}\nYou should revert the fallback to just region and plan, this is unnecessary complexity.`;
    assert.equal(isCollisionContradictionComment(body), true);
});

test("collision: flags 'just use region and plan' phrasing", () => {
    const body = `${badge("low")}\n${MARKER}\nJust use region and plan for the seed, no need for anything else.`;
    assert.equal(isCollisionContradictionComment(body), true);
});

test("collision: flags 'unnecessary uniqueness' phrasing", () => {
    const body = `${badge("low")}\n${MARKER}\nThe tenant-scoping here adds unnecessary complexity to a simple cache key.`;
    assert.equal(isCollisionContradictionComment(body), true);
});

test("collision: does not flag a comment agreeing with the applied fix", () => {
    const body = `${badge("low")}\n${MARKER}\nGood, keeping the fallback tenant-scoped avoids cross-tenant collisions here.`;
    assert.equal(isCollisionContradictionComment(body), false);
});

test("collision: does not flag an unrelated finding on the same file", () => {
    const body = `${badge("low")}\n${MARKER}\nConsider renaming 'cfg' to 'options' for clarity.`;
    assert.equal(isCollisionContradictionComment(body), false);
});

test("collision: does not flag a comment merely describing the fix in past tense", () => {
    const body = `${badge("low")}\n${MARKER}\nKeeping the fallback tenant-scoped fixed the collision — nice catch.`;
    assert.equal(isCollisionContradictionComment(body), false);
});
