import { resolveKodyRuleById } from "../../../apps/web/src/core/utils/kody-rules/resolve-rule";

describe("resolveKodyRuleById", () => {
    const targetId = "32dfa554-6238-4b19-84f8-17330f6abe94";
    const target = { uuid: targetId, title: "Java/Spring rule" };

    function buildResolver(overrides: Partial<any> = {}) {
        return {
            byRepo: jest.fn().mockResolvedValue([]),
            inherited: jest.fn().mockResolvedValue({
                directoryRules: [],
                globalRules: [],
                repoRules: [],
            }),
            all: jest.fn().mockResolvedValue([]),
            ...overrides,
        };
    }

    it("finds the rule via the repository-scoped lookup when available", async () => {
        const resolver = buildResolver({
            byRepo: jest.fn().mockResolvedValue([target]),
        });

        const result = await resolveKodyRuleById(
            targetId,
            { repositoryId: "769144833", directoryId: "dir-1", teamId: "team-1" },
            resolver,
        );

        expect(result).toEqual(target);
        expect(resolver.inherited).not.toHaveBeenCalled();
        expect(resolver.all).not.toHaveBeenCalled();
    });

    it("falls back to inherited rules when the repo lookup is empty", async () => {
        const resolver = buildResolver({
            inherited: jest.fn().mockResolvedValue({
                directoryRules: [],
                globalRules: [target],
                repoRules: [],
            }),
        });

        const result = await resolveKodyRuleById(
            targetId,
            { repositoryId: "769144833", directoryId: "dir-1", teamId: "team-1" },
            resolver,
        );

        expect(result).toEqual(target);
        expect(resolver.all).not.toHaveBeenCalled();
    });

    it("falls back to the org-wide listing when teamId is missing (broken deep-link)", async () => {
        // Reproduces the client complaint "link doesn't even work" —
        // Kody-generated comment links omit teamId/directoryId, so the
        // repo-scoped and inherited lookups can't find the rule. The
        // org-wide fallback by UUID rescues the deep-link.
        const resolver = buildResolver({
            all: jest.fn().mockResolvedValue([
                { uuid: "some-other-rule" },
                target,
            ]),
        });

        const result = await resolveKodyRuleById(
            targetId,
            { repositoryId: "769144833" }, // no teamId, no directoryId
            resolver,
        );

        expect(result).toEqual(target);
        expect(resolver.byRepo).toHaveBeenCalledWith("769144833", undefined);
        expect(resolver.inherited).not.toHaveBeenCalled(); // skipped without teamId
        expect(resolver.all).toHaveBeenCalled();
    });

    it("returns null when the rule is nowhere", async () => {
        const resolver = buildResolver();

        const result = await resolveKodyRuleById(
            "does-not-exist",
            { repositoryId: "769144833", teamId: "team-1" },
            resolver,
        );

        expect(result).toBeNull();
        expect(resolver.byRepo).toHaveBeenCalled();
        expect(resolver.inherited).toHaveBeenCalled();
        expect(resolver.all).toHaveBeenCalled();
    });

    it("tolerates errors from individual fetchers by trying the next one", async () => {
        const resolver = buildResolver({
            byRepo: jest.fn().mockRejectedValue(new Error("network")),
            all: jest.fn().mockResolvedValue([target]),
        });

        const result = await resolveKodyRuleById(
            targetId,
            { repositoryId: "769144833" },
            resolver,
        );

        expect(result).toEqual(target);
    });
});
