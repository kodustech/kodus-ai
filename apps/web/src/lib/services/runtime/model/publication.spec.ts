import { publicationLine } from "./publication";

describe("publicationLine", () => {
    it("only a posted result reads as on the pull request", () => {
        expect(publicationLine("check", { status: "published" })).toEqual({
            label: "On the pull request",
            tone: "success",
        });
        expect(
            publicationLine("comment", { status: "published", fallback: true }),
        ).toMatchObject({ label: "Short notice only", tone: "warning" });
    });

    it("a pending comment says what the PR still shows, or that Kodus retries", () => {
        expect(
            publicationLine("comment", { status: "pending", showing: "reporting" }),
        ).toEqual({
            label: "Not on the PR yet",
            tone: "info",
            detail: "The PR comment still shows progress (writing the report).",
        });
        expect(
            publicationLine("comment", {
                status: "pending",
                retrying: true,
                redriveAttempts: 2,
            }),
        ).toEqual({
            label: "Retrying",
            tone: "warning",
            detail: "The last delivery failed; Kodus is retrying (retry 2).",
        });
    });

    it("says when Kodus gave up, why a post was skipped, and what a Run does not post", () => {
        expect(publicationLine("check", { status: "failed" })).toMatchObject({
            label: "Could not post",
            tone: "danger",
        });
        expect(
            publicationLine("check", {
                status: "skipped",
                reason: "checks_unavailable",
            }).detail,
        ).toContain("has no checks");
        expect(
            publicationLine("check", {
                status: "skipped",
                reason: "status_permission_missing",
            }),
        ).toEqual({
            label: "Not posted",
            tone: "neutral",
            detail: 'The GitHub token connected to Kodus cannot write commit statuses. Give it the "Commit statuses: Read and write" permission (fine-grained token) or the repo:status scope (classic token); the comment carries the result meanwhile.',
        });
        expect(
            publicationLine("check", { status: "skipped", reason: "stale_check" }),
        ).toEqual({
            label: "Not posted",
            tone: "neutral",
            detail: "A newer Run on this commit owns the check.",
        });
        expect(publicationLine("comment", { status: "not_expected" })).toEqual({
            label: "No comment for this Run",
            tone: "neutral",
        });
    });
});
