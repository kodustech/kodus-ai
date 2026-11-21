import type { RunPublication } from "../contracts";
import { publicationWarnings, runStatusLine } from "./run-status-line";

const run = (state: string, extra = {}) =>
    ({
        state,
        headSha: "c76abde1111",
        baseSha: "aaaaaaa",
        baseBranch: "main",
        ...extra,
    }) as Parameters<typeof runStatusLine>[0];

describe("runStatusLine", () => {
    it("counts regressions with the duration and the commits", () => {
        expect(runStatusLine(run("regression"), 1, 120_000)).toBe(
            "✕ 1 regression · 2 min 00 s · c76abde vs main",
        );
    });
    it("says a pass in a few words", () => {
        expect(runStatusLine(run("no_regressions"), 0)).toBe(
            "✓ No regressions · c76abde vs main",
        );
    });
    it("gives the reason of a state with no verdict", () => {
        expect(
            runStatusLine(
                run("cancelled", { reason: "Cancelled by a teammate" }),
                0,
            ),
        ).toContain("Cancelled by a teammate");
    });
});

describe("publicationWarnings", () => {
    const view = (status: string, reason?: string) => ({ status, reason });
    const publication = (check: object, comment: object) =>
        ({
            postsToPullRequest: true,
            check,
            comment,
        }) as unknown as RunPublication;

    it("is empty when everything posted", () => {
        expect(
            publicationWarnings(
                publication(view("published"), view("published")),
            ),
        ).toEqual([]);
    });
    it("warns about a check the token could not write", () => {
        const [w] = publicationWarnings(
            publication(
                view("skipped", "status_permission_missing"),
                view("published"),
            ),
        );
        expect(w.title).toBe(
            "Check not posted: the GitHub token can't write commit statuses.",
        );
        expect(w.fix).toContain("Commit statuses");
    });
    it("warns about a failed comment", () => {
        expect(
            publicationWarnings(publication(view("published"), view("failed"))),
        ).toHaveLength(1);
    });
});
