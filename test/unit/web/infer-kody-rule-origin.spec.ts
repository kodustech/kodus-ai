import {
    inferRuleOrigin,
    isIdeRuleSource,
} from "../../../apps/web/src/core/utils/kody-rules/infer-origin";

describe("isIdeRuleSource", () => {
    it.each([
        ".cursorrules",
        "applications/backoffice-bff/.cursorrules",
        "qantilever/.cursor/rules/logging.mdc",
        "CLAUDE.md",
        ".github/copilot-instructions.md",
        ".github/instructions/typescript.instructions.md",
        ".agents.md",
        ".agent.md",
        ".windsurfrules",
        ".claude/settings.json",
        ".opencode.json",
        ".aider.conf.yml",
        ".aiderignore",
        ".sourcegraph/style.rule.md",
        ".rules/naming.md",
        ".kody/rules/memory.md",
        "docs/coding-standards/typescript.md",
    ])("classifies %s as an IDE rule source", (sourcePath) => {
        expect(isIdeRuleSource(sourcePath)).toBe(true);
    });

    it.each([
        "esbuild.config.js",
        "package.json",
        "src/**/*.ts",
        "src/utils/foo.ts",
        "tsconfig.json",
        null,
        undefined,
        "",
    ])("classifies %s as NOT an IDE rule source", (sourcePath) => {
        expect(isIdeRuleSource(sourcePath as any)).toBe(false);
    });
});

describe("inferRuleOrigin", () => {
    // Client data: b207a89c (Logging Best Practices) — real IDE sync
    it('returns "Auto-sync" when sourcePath points at a .cursor/rules/*.mdc file', () => {
        const result = inferRuleOrigin({
            sourcePath: "qantilever/.cursor/rules/logging.mdc",
            origin: "user",
        });
        expect(result).toBe("Auto-sync");
    });

    // Client data: 32dfa554 (Java/Spring Arch) — real IDE sync
    it('returns "Auto-sync" for a .cursorrules nested in a subdirectory', () => {
        const result = inferRuleOrigin({
            sourcePath: "applications/backoffice-bff/.cursorrules",
            origin: "user",
        });
        expect(result).toBe("Auto-sync");
    });

    // Local reproduction: 3 rules from fast-sync on a fresh account where
    // sourcePath is a glob (bug that falls back path → sourcePath) or a
    // config file that the onboarding LLM analysed.
    it('returns "Onboard" when sourcePath is a glob (fast-sync fallback)', () => {
        const result = inferRuleOrigin({
            sourcePath: "src/**/*.ts",
            origin: "user",
        });
        expect(result).toBe("Onboard");
    });

    it('returns "Onboard" when sourcePath is a config file from the onboarding analysis', () => {
        const result = inferRuleOrigin({
            sourcePath: "esbuild.config.js",
            origin: "user",
        });
        expect(result).toBe("Onboard");
    });

    // Client data: ff8ecc7e (Transaction Management) — hand-authored
    it('returns "manual" when sourcePath is null', () => {
        const result = inferRuleOrigin({
            sourcePath: null,
            origin: "user",
        });
        expect(result).toBe("manual");
    });

    it('returns "Kody-generated" when origin is "generated", ignoring sourcePath', () => {
        expect(
            inferRuleOrigin({
                sourcePath: null,
                origin: "generated",
            }),
        ).toBe("Kody-generated");

        // Generated origin wins even if someone leaked a sourcePath in.
        expect(
            inferRuleOrigin({
                sourcePath: ".cursorrules",
                origin: "generated",
            }),
        ).toBe("Kody-generated");
    });

    it("handles missing/undefined fields gracefully", () => {
        expect(inferRuleOrigin({} as any)).toBe("manual");
        expect(inferRuleOrigin({ sourcePath: undefined } as any)).toBe(
            "manual",
        );
    });
});
