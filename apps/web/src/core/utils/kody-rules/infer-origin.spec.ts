import { inferRuleOrigin, isIdeRuleSource } from "./infer-origin";

describe("inferRuleOrigin — .agents/rules discovery", () => {
    it("ships the .agents/rules/** pattern in the web mirror list", () => {
        expect(isIdeRuleSource(".agents/rules/architecture.md")).toBe(true);
    });

    it("recognises nested .agents/rules files (monorepo subdir)", () => {
        expect(
            isIdeRuleSource("applications/sales/.agents/rules/style.md"),
        ).toBe(true);
    });

    it("classifies a repo-root .agents/rules file as Auto-sync", () => {
        expect(
            inferRuleOrigin({
                origin: null,
                sourcePath: ".agents/rules/architecture.md",
            }),
        ).toBe("Auto-sync");
    });

    it("classifies a nested .agents/rules file as Auto-sync", () => {
        expect(
            inferRuleOrigin({
                origin: null,
                sourcePath: "applications/sales/.agents/rules/style.md",
            }),
        ).toBe("Auto-sync");
    });
});
