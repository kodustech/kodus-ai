import {
    countConfigOverridesByRoute,
    countConfigOverridesForRoutes,
} from "../../../apps/web/src/app/(app)/settings/_utils/count-overrides";

// Minimal IFormattedConfigProperty factories — the real type lives in
// apps/web/.../code-review/_types but we don't need its full shape here
// since the function only inspects { value, level, overriddenLevel,
// overriddenValue }.
const overridden = (
    level: string,
    overriddenLevel: string,
    value: unknown = true,
    overriddenValue: unknown = false,
) => ({ value, level, overriddenValue, overriddenLevel });

const noOverride = (level: string, value: unknown = false) => ({
    value,
    level,
});

describe("countConfigOverridesByRoute — kody-rules", () => {
    it("does NOT count ideRulesSyncEnabled overrides", () => {
        // REGRESSION: the auto-sync toggle is an import action, not a rule
        // policy. Including it in the override count made the Kody Rules
        // nav badge read "1" on repos that had simply toggled IDE sync,
        // which users interpreted as "1 custom rule".
        const config: any = {
            ideRulesSyncEnabled: overridden("repository", "default", true, false),
            kodyRulesGeneratorEnabled: noOverride("default"),
            llmGeneratedMemoriesRequireApproval: noOverride("default"),
        };

        const count = countConfigOverridesByRoute(
            config,
            "kody-rules",
            "repository" as any,
        );

        expect(count).toBe(0);
    });

    it("counts kodyRulesGeneratorEnabled and llmGeneratedMemoriesRequireApproval overrides", () => {
        const config: any = {
            kodyRulesGeneratorEnabled: overridden("repository", "default"),
            llmGeneratedMemoriesRequireApproval: overridden(
                "repository",
                "default",
            ),
            ideRulesSyncEnabled: noOverride("default"),
        };

        const count = countConfigOverridesByRoute(
            config,
            "kody-rules",
            "repository" as any,
        );

        expect(count).toBe(2);
    });

    it("returns 0 when no rule-policy fields have repository-level overrides", () => {
        const config: any = {
            kodyRulesGeneratorEnabled: noOverride("default"),
            llmGeneratedMemoriesRequireApproval: noOverride("default"),
            ideRulesSyncEnabled: noOverride("default"),
        };

        const count = countConfigOverridesByRoute(
            config,
            "kody-rules",
            "repository" as any,
        );

        expect(count).toBe(0);
    });

    it("ignores fields outside the kody-rules prefix list", () => {
        const config: any = {
            // Belongs to the general route, not kody-rules
            ignorePaths: overridden("repository", "default"),
            kodyRulesGeneratorEnabled: noOverride("default"),
        };

        const count = countConfigOverridesByRoute(
            config,
            "kody-rules",
            "repository" as any,
        );

        expect(count).toBe(0);
    });
});

describe("countConfigOverridesForRoutes — aggregate badge", () => {
    it("aggregates overrides across multiple routes without double-counting", () => {
        const config: any = {
            kodyRulesGeneratorEnabled: overridden("repository", "default"),
            ignorePaths: overridden("repository", "default"),
            // ideRulesSyncEnabled override is invisible to both routes
            ideRulesSyncEnabled: overridden("repository", "default"),
        };

        const count = countConfigOverridesForRoutes(
            config,
            ["general", "kody-rules"],
            "repository" as any,
        );

        // 1 from kody-rules (kodyRulesGeneratorEnabled) + 1 from general
        // (ignorePaths). ideRulesSyncEnabled NOT counted under kody-rules.
        expect(count).toBe(2);
    });
});
