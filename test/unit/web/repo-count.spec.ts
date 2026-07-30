import {
    repoCountKey,
    resolveRepoCount,
    type KodyRuleRepositoryCount,
} from "../../../apps/web/src/core/utils/kody-rules/repo-count";

describe("repoCountKey", () => {
    it("keys repository-level rules under the repo id alone", () => {
        expect(repoCountKey("repo-1")).toBe("repo-1");
        expect(repoCountKey("repo-1", null)).toBe("repo-1");
        expect(repoCountKey("repo-1", undefined)).toBe("repo-1");
        // empty string is falsy → repository-level
        expect(repoCountKey("repo-1", "")).toBe("repo-1");
    });

    it("keys directory-level rules under repo::dir", () => {
        expect(repoCountKey("repo-1", "dir-9")).toBe("repo-1::dir-9");
    });

    it("does not collapse different repos / dirs onto the same key", () => {
        expect(repoCountKey("repo-1")).not.toBe(repoCountKey("repo-2"));
        expect(repoCountKey("repo-1", "dir-1")).not.toBe(
            repoCountKey("repo-1", "dir-2"),
        );
        // a repo and one of its directories must not collide
        expect(repoCountKey("repo-1")).not.toBe(repoCountKey("repo-1", "dir-1"));
    });
});

describe("resolveRepoCount", () => {
    const counts: KodyRuleRepositoryCount[] = [
        { repositoryId: "repo-1", directoryId: null, count: 4 },
        { repositoryId: "repo-1", directoryId: "dir-9", count: 2 },
        { repositoryId: "repo-2", directoryId: null, count: 7 },
    ];

    it("resolves the repository-level count (directoryId omitted)", () => {
        expect(resolveRepoCount(counts, "repo-1")).toBe(4);
        expect(resolveRepoCount(counts, "repo-2")).toBe(7);
    });

    it("resolves the directory-level count without picking up the repo total", () => {
        expect(resolveRepoCount(counts, "repo-1", "dir-9")).toBe(2);
    });

    it("returns 0 for a scope with no entry", () => {
        expect(resolveRepoCount(counts, "repo-unknown")).toBe(0);
        expect(resolveRepoCount(counts, "repo-1", "dir-absent")).toBe(0);
    });

    it("returns 0 while data is still loading (undefined)", () => {
        expect(resolveRepoCount(undefined, "repo-1")).toBe(0);
    });
});
