import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
    addedLinesFromPatch,
    findPlacementViolations,
    type ChangedFile,
} from "../diff-position.js";

// A realistic two-hunk patch: one pure insertion, one replacement.
const PATCH = [
    "@@ -1,4 +1,6 @@",
    " import { resolve } from './resolve';",
    "+import { assertNotNull } from './assert';",
    "+",
    " export function handler(code: string) {",
    "     const target = resolve(code);",
    "@@ -20,7 +22,7 @@ export function handler(code: string) {",
    "     const url = target.url;",
    "-    return redirect(url as string);",
    "+    assertNotNull(url, 'resolved target has no url');",
    "+    return redirect(url);",
    " }",
].join("\n");

test("addedLinesFromPatch: only + lines, numbered in the new file", () => {
    const added = addedLinesFromPatch(PATCH);
    // hunk 1 starts at new line 1: line 1 context, 2 and 3 are the additions
    assert.ok(added.has(2), "first inserted import");
    assert.ok(added.has(3), "blank line after it");
    assert.ok(!added.has(1), "context line is not an addition");
    assert.ok(!added.has(4), "context line is not an addition");
    // hunk 2 starts at new line 22: 22 context, then the two + lines
    assert.ok(added.has(23));
    assert.ok(added.has(24));
    assert.ok(!added.has(25), "trailing context line");
});

test("addedLinesFromPatch: removals consume no new-file numbering", () => {
    const added = addedLinesFromPatch(
        ["@@ -1,3 +1,2 @@", " keep", "-gone", "-also gone", "+replacement"].join("\n"),
    );
    assert.deepEqual([...added], [2], "the + line follows the single context line");
});

test("addedLinesFromPatch: ignores the no-newline marker", () => {
    const added = addedLinesFromPatch(
        ["@@ -1,1 +1,1 @@", "-old", "+new", "\\ No newline at end of file"].join("\n"),
    );
    assert.deepEqual([...added], [1]);
});

test("addedLinesFromPatch: tolerates a patch with no hunk header", () => {
    assert.equal(addedLinesFromPatch("+orphan line").size, 0);
});

const FILES: ChangedFile[] = [{ path: "src/handler.ts", patch: PATCH }];

test("a comment on an added line is valid", () => {
    assert.deepEqual(
        findPlacementViolations(FILES, [
            { path: "src/handler.ts", line: 23, side: "RIGHT" },
        ]),
        [],
    );
});

// The GitLab bug class: the comment arrives, the old assertions pass, and it
// is hanging off a line the PR never touched.
test("a comment on a context line is a violation", () => {
    const v = findPlacementViolations(FILES, [
        { path: "src/handler.ts", line: 25, side: "RIGHT" },
    ]);
    assert.equal(v.length, 1);
    assert.equal(v[0].reason, "line-not-added");
    assert.match(v[0].detail, /src\/handler\.ts:25/);
});

test("a comment on a file the PR does not touch is a violation", () => {
    const v = findPlacementViolations(FILES, [{ path: "README.md", line: 1 }]);
    assert.equal(v.length, 1);
    assert.equal(v[0].reason, "file-not-in-diff");
});

test("a comment on the LEFT (removed) side is a violation", () => {
    const v = findPlacementViolations(FILES, [
        { path: "src/handler.ts", line: 23, side: "LEFT" },
    ]);
    assert.equal(v.length, 1);
    assert.equal(v[0].reason, "left-side");
});

test("file-level comments (no line anchor) are allowed", () => {
    assert.deepEqual(
        findPlacementViolations(FILES, [{ path: "src/handler.ts" }]),
        [],
    );
});

test("binary files have no patch — never invent a violation", () => {
    assert.deepEqual(
        findPlacementViolations([{ path: "logo.png" }], [
            { path: "logo.png", line: 3 },
        ]),
        [],
    );
});

test("reports every violation, not just the first", () => {
    const v = findPlacementViolations(FILES, [
        { path: "src/handler.ts", line: 23 }, // ok
        { path: "src/handler.ts", line: 1 }, // context
        { path: "nope.ts", line: 5 }, // wrong file
    ]);
    assert.equal(v.length, 2);
});
