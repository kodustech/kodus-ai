import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
    extractSuggestedCode,
    isContradictionComment,
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

test("flags the literal reversal phrasing", () => {
    const body = `${badge("low")}\n${MARKER}\nJust return user.name directly here, the guard adds no value.`;
    assert.equal(isContradictionComment(body), true);
});
