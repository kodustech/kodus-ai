import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isContradictionComment } from "../../scenarios/review-decision-memory.js";

const MARKER = "<!-- kody-codereview -->";
const badge = (sev: string) =>
    `![kody code-review](https://img.shields.io/badge/kody-code--review-312B4B) ![Bug](https://img.shields.io/badge/Bug-B71C1C) ![${sev}](https://img.shields.io/badge/severity_level-${sev}-6B6B92)`;

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

test("flags the literal reversal phrasing", () => {
    const body = `${badge("low")}\n${MARKER}\nJust return user.name directly here, the guard adds no value.`;
    assert.equal(isContradictionComment(body), true);
});
