import {
    ruleMatchesFile,
    splitRulesByFileMatch,
} from "../../../apps/web/src/core/utils/kody-rules/match-file-against-rules";

describe("ruleMatchesFile", () => {
    it("returns false when filePath is empty", () => {
        expect(ruleMatchesFile("**/*", "")).toBe(false);
    });

    it('matches every file when path is empty or "**\\/*"', () => {
        expect(ruleMatchesFile("", "src/foo.ts")).toBe(true);
        expect(ruleMatchesFile("**/*", "src/foo.ts")).toBe(true);
    });

    it("respects scoped globs like 'applications/backoffice-bff/**\\/*'", () => {
        expect(
            ruleMatchesFile(
                "applications/backoffice-bff/**/*",
                "applications/backoffice-bff/src/Foo.java",
            ),
        ).toBe(true);
        expect(
            ruleMatchesFile(
                "applications/backoffice-bff/**/*",
                "applications/sales-flow/src/Foo.java",
            ),
        ).toBe(false);
    });

    it("treats comma-separated globs as OR", () => {
        const path = "src/**/*.ts,test/**/*.ts";
        expect(ruleMatchesFile(path, "src/utils/foo.ts")).toBe(true);
        expect(ruleMatchesFile(path, "test/spec/bar.ts")).toBe(true);
        expect(ruleMatchesFile(path, "docs/intro.md")).toBe(false);
    });

    it("matches dotfiles via dot:true", () => {
        expect(
            ruleMatchesFile(
                "**/.cursorrules",
                "applications/backoffice-bff/.cursorrules",
            ),
        ).toBe(true);
    });

    it("strips leading slashes on the file path before matching", () => {
        expect(ruleMatchesFile("src/**/*.ts", "/src/utils/foo.ts")).toBe(true);
    });
});

describe("splitRulesByFileMatch", () => {
    it("partitions matched and unmatched preserving order", () => {
        const rules = [
            { uuid: "1", path: "src/**/*.ts" },
            { uuid: "2", path: "test/**/*" },
            { uuid: "3", path: "docs/**/*.md" },
            { uuid: "4", path: "**/*" },
        ];

        const result = splitRulesByFileMatch(rules, "src/utils/foo.ts");

        expect(result.matched.map((r) => r.uuid)).toEqual(["1", "4"]);
        expect(result.unmatched.map((r) => r.uuid)).toEqual(["2", "3"]);
    });

    it("returns no matches when no rule applies", () => {
        const rules = [{ uuid: "1", path: "src/**/*.kt" }];
        const result = splitRulesByFileMatch(rules, "src/utils/foo.ts");
        expect(result.matched).toEqual([]);
        expect(result.unmatched).toEqual(rules);
    });
});
