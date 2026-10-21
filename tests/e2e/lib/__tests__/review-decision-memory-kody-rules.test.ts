import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isKodyRuleContradictionComment } from "../../scenarios/review-decision-memory-kody-rules.js";

const MARKER = "<!-- kody-codereview -->";
const badge = (sev: string) =>
    `![kody code-review](https://img.shields.io/badge/kody-code--review-312B4B) ![Kody Rules](https://img.shields.io/badge/Kody_Rules-312B4B) ![${sev}](https://img.shields.io/badge/severity_level-${sev}-6B6B92)`;

// isKodyRuleContradictionComment — the review-decision-memory-kody-rules
// scenario's contradiction detector, covering the rules-judge code path
// (kody-rules-sharded.judge.ts), separate from the bug/security/performance
// finder that review-decision-memory.ts's own detectors cover.

test("flags a directive to revert to the placeholder", () => {
    const body = `${badge("medium")}\n${MARKER}\nYou should revert to the placeholder here, this change isn't needed.`;
    assert.equal(isKodyRuleContradictionComment(body), true);
});

test("flags 'restore PLACEHOLDER_TOKEN' phrasing", () => {
    const body = `${badge("low")}\n${MARKER}\nPlease restore PLACEHOLDER_TOKEN — the real value shouldn't be hardcoded here.`;
    assert.equal(isKodyRuleContradictionComment(body), true);
});

test("flags 'PLACEHOLDER_TOKEN should remain' phrasing", () => {
    const body = `${badge("low")}\n${MARKER}\nPLACEHOLDER_TOKEN should remain until the real config value is available.`;
    assert.equal(isKodyRuleContradictionComment(body), true);
});

test("does not flag a comment agreeing with the applied fix", () => {
    const body = `${badge("low")}\n${MARKER}\nGood, replacing the placeholder with a real value resolves the rule violation.`;
    assert.equal(isKodyRuleContradictionComment(body), false);
});

test("does not flag an unrelated finding on the same file", () => {
    const body = `${badge("low")}\n${MARKER}\nConsider adding a type annotation for CONFIG_TOKEN.`;
    assert.equal(isKodyRuleContradictionComment(body), false);
});

test("does not flag a comment merely describing the fix in past tense", () => {
    const body = `${badge("low")}\n${MARKER}\nReplacing PLACEHOLDER_TOKEN with a real value fixed the rule violation — nice catch.`;
    assert.equal(isKodyRuleContradictionComment(body), false);
});

test("does not flag a comment that merely mentions the old value while describing the fix", () => {
    const body = `${badge("low")}\n${MARKER}\nThe constant used to be PLACEHOLDER_TOKEN; it's now a real, environment-specific value.`;
    assert.equal(isKodyRuleContradictionComment(body), false);
});
