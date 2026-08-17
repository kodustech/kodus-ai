import { buildReviewDeepLinkUrl } from "./utils";

describe("buildReviewDeepLinkUrl", () => {
    it("deep-links to the first delivered suggestion when known", () => {
        const href = buildReviewDeepLinkUrl("repo-1", 42, {
            id: "sugg-abc",
            filePath: "src/file.ts",
        });

        expect(href).toBe(
            "/pull-requests/repo-1/42?file=src%2Ffile.ts&suggestion=sugg-abc",
        );
    });

    it("encodes special characters in the file path", () => {
        const href = buildReviewDeepLinkUrl("repo-1", 42, {
            id: "sugg-1",
            filePath: "src/My File (2).ts",
        });

        // encodeURIComponent keeps RFC-3986 reserved chars like () unescaped.
        expect(href).toBe(
            "/pull-requests/repo-1/42?file=src%2FMy%20File%20(2).ts&suggestion=sugg-1",
        );
    });

    it("falls back to the plain review URL without a delivered suggestion", () => {
        expect(
            buildReviewDeepLinkUrl("repo-1", 42, null),
        ).toBe("/pull-requests/repo-1/42");

        expect(
            buildReviewDeepLinkUrl("repo-1", 42, undefined),
        ).toBe("/pull-requests/repo-1/42");

        expect(
            buildReviewDeepLinkUrl("repo-1", 42, { id: "", filePath: "x.ts" }),
        ).toBe("/pull-requests/repo-1/42");
    });
});
