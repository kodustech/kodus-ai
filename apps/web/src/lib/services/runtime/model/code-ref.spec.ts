import { codeRefOf } from "./code-ref";

const HEAD = "5d49b8a".padEnd(40, "0");
const PR = "https://github.com/kodus/demo-grafana/pull/4";

describe("codeRefOf", () => {
    it("links to the file at the PR's head on GitHub", () => {
        expect(
            codeRefOf(
                { file: "pkg/api/health.go", line: 23 },
                { url: PR, headSha: HEAD },
            ),
        ).toEqual({
            label: "pkg/api/health.go:23",
            href: `https://github.com/kodus/demo-grafana/blob/${HEAD}/pkg/api/health.go#L23`,
        });
    });

    it("is plain text off GitHub or without the PR's URL", () => {
        const ref = { file: "pkg/api/health.go", line: 23 };
        expect(codeRefOf(ref)).toEqual({ label: "pkg/api/health.go:23" });
        expect(
            codeRefOf(ref, {
                url: "https://gitlab.com/kodus/demo-grafana/-/merge_requests/4",
                headSha: HEAD,
            }),
        ).toEqual({ label: "pkg/api/health.go:23" });
        expect(codeRefOf(ref, { url: PR })).toEqual({
            label: "pkg/api/health.go:23",
        });
    });

    it("drops a bad line and never links a path that escapes the repository", () => {
        expect(
            codeRefOf({ file: "a.go", line: 0 }, { url: PR, headSha: HEAD }),
        ).toEqual({
            label: "a.go",
            href: `https://github.com/kodus/demo-grafana/blob/${HEAD}/a.go`,
        });
        for (const file of [
            "../secrets",
            "/etc/passwd",
            "javascript:alert(1)",
            "a//b",
        ])
            expect(
                codeRefOf({ file }, { url: PR, headSha: HEAD })?.href,
            ).toBeUndefined();
    });

    it("encodes each path segment", () => {
        expect(
            codeRefOf({ file: "docs/a b#c.md" }, { url: PR, headSha: HEAD })
                ?.href,
        ).toBe(
            `https://github.com/kodus/demo-grafana/blob/${HEAD}/docs/a%20b%23c.md`,
        );
    });

    it("says nothing without a file", () => {
        expect(codeRefOf(undefined)).toBeUndefined();
        expect(codeRefOf({ file: " " })).toBeUndefined();
    });
});
