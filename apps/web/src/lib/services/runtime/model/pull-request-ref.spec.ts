import { parsePullRequestRef, parsePullRequestRefs } from "./pull-request-ref";

describe("parsePullRequestRef", () => {
    it("reads a pull request from a URL of this repository or a number", () => {
        expect(parsePullRequestRef("482")).toEqual({ ok: true, prNumber: 482 });
        expect(parsePullRequestRef("#12")).toEqual({ ok: true, prNumber: 12 });
        expect(
            parsePullRequestRef(
                "https://github.com/acme/checkout-api/pull/482",
                "acme/checkout-api",
            ),
        ).toEqual({ ok: true, prNumber: 482 });
        expect(
            parsePullRequestRef(
                "https://github.com/acme/checkout-api/pull/482/files",
                "acme/checkout-api",
            ),
        ).toEqual({ ok: true, prNumber: 482 });
        expect(
            parsePullRequestRef(
                "https://gitlab.com/acme/api/-/merge_requests/7",
                "acme/api",
            ),
        ).toEqual({ ok: true, prNumber: 7 });
        expect(
            parsePullRequestRef(
                "https://github.com/other/repo/pull/1",
                "acme/checkout-api",
            ),
        ).toMatchObject({ ok: false });
        expect(parsePullRequestRef("hello")).toMatchObject({ ok: false });
        expect(parsePullRequestRef("0")).toMatchObject({ ok: false });
    });
});

describe("parsePullRequestRefs", () => {
    it("reads several, separated by commas or spaces, without duplicates", () => {
        expect(parsePullRequestRefs("482, #479 471 482")).toEqual({
            ok: true,
            prNumbers: [482, 479, 471],
        });
        expect(
            parsePullRequestRefs(
                "https://github.com/acme/api/pull/3 4",
                "acme/api",
            ),
        ).toEqual({ ok: true, prNumbers: [3, 4] });
    });

    it("names the first bad entry and caps at five", () => {
        expect(parsePullRequestRefs("1 two")).toEqual({
            ok: false,
            error: "two: Not a pull request URL.",
        });
        expect(parsePullRequestRefs("1 2 3 4 5 6")).toMatchObject({
            ok: false,
            error: "Up to 5 pull requests at a time.",
        });
        expect(parsePullRequestRefs("  ")).toMatchObject({ ok: false });
    });
});
