import type { ListModelOverridesResult } from "@services/organizationParameters/fetch";

import { groupOverrides } from "./per-repository-overrides";

const result = (
    partial: Partial<ListModelOverridesResult>,
): ListModelOverridesResult => ({
    overrides: [],
    mismatchedCount: 0,
    customAgentOverrides: [],
    ...partial,
});

describe("groupOverrides", () => {
    it("groups repository and folder review models (unchanged)", () => {
        const repos = groupOverrides(
            result({
                overrides: [
                    { scope: "global", model: "m-global", inCurrentProviderCatalog: null },
                    {
                        scope: "repository",
                        repositoryId: "r1",
                        repositoryName: "acme/api",
                        model: "m-repo",
                        inCurrentProviderCatalog: null,
                    },
                    {
                        scope: "directory",
                        repositoryId: "r1",
                        repositoryName: "acme/api",
                        directoryId: "d1",
                        directoryName: "payments",
                        model: "m-dir",
                        inCurrentProviderCatalog: null,
                    },
                ],
            }),
        );
        expect(repos).toEqual([
            {
                id: "r1",
                name: "acme/api",
                model: "m-repo",
                folders: [{ id: "d1", name: "payments", model: "m-dir" }],
                agents: [],
            },
        ]);
    });

    it("lists each repository's custom agents that pin a model (#2172)", () => {
        const repos = groupOverrides(
            result({
                overrides: [
                    {
                        scope: "repository",
                        repositoryId: "r1",
                        repositoryName: "acme/api",
                        model: "m-repo",
                        inCurrentProviderCatalog: null,
                    },
                ],
                customAgentOverrides: [
                    {
                        scope: "repository",
                        repositoryId: "r1",
                        repositoryName: "acme/api",
                        agentId: "a1",
                        agentName: "API contracts",
                        step: "run",
                        model: "m-agent",
                    },
                    {
                        scope: "directory",
                        repositoryId: "r1",
                        repositoryName: "acme/api",
                        directoryId: "d1",
                        directoryName: "payments",
                        agentId: "a2",
                        agentName: "Money math",
                        step: "check",
                        model: "m-check",
                    },
                    {
                        scope: "repository",
                        repositoryId: "r2",
                        repositoryName: "acme/web",
                        agentId: "a3",
                        agentName: "A11y",
                        step: "run",
                        model: "m-a11y",
                    },
                ],
            }),
        );

        expect(repos.map((r) => r.id)).toEqual(["r1", "r2"]);
        expect(repos[0].agents).toEqual([
            {
                id: "r1:a1:run",
                agentId: "a1",
                agentName: "API contracts",
                step: "run",
                model: "m-agent",
                href: "/settings/code-review/r1/agents/a1",
            },
            {
                id: "r1:d1:a2:check",
                agentId: "a2",
                agentName: "Money math",
                step: "check",
                model: "m-check",
                folderName: "payments",
                href: "/settings/code-review/r1/agents/a2?directoryId=d1",
            },
        ]);
        // A repository with only an agent pin still shows, inheriting the
        // review model.
        expect(repos[1].name).toBe("acme/web");
        expect(repos[1].model).toBeUndefined();
        expect(repos[1].agents).toHaveLength(1);
    });

    it("shows agents defined for every repository under All repositories", () => {
        const repos = groupOverrides(
            result({
                customAgentOverrides: [
                    {
                        scope: "global",
                        agentId: "g1",
                        agentName: "Docs",
                        step: "run",
                        model: "m-docs",
                        href: "/settings/code-review/global/agents/g1",
                    },
                ],
            }),
        );
        expect(repos).toEqual([
            {
                id: "__global__",
                name: "All repositories",
                folders: [],
                agents: [
                    {
                        id: "__global__:g1:run",
                        agentId: "g1",
                        agentName: "Docs",
                        step: "run",
                        model: "m-docs",
                        href: "/settings/code-review/global/agents/g1",
                    },
                ],
            },
        ]);
    });

    it("tolerates an API without custom agent pins", () => {
        expect(
            groupOverrides({ overrides: [], mismatchedCount: 0 } as any),
        ).toEqual([]);
        expect(groupOverrides(null)).toEqual([]);
    });
});
