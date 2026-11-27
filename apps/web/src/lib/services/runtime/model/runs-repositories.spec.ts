import { runsRepositories } from "./runs-repositories";

const repos = [
    { id: "r-mono", name: "acme/mono" },
    { id: "r-app", name: "acme/app" },
    { id: "r-shop", name: "acme/shop" },
    { id: "r-api", name: "acme/api" },
];

describe("runsRepositories", () => {
    it("puts the repositories with an environment first, changed last first, with their state, and opens on the first of them", () => {
        const out = runsRepositories(repos, [
            // As the list answers it: an active environment carries the setup that made it active.
            {
                environmentId: "e1",
                repositoryId: "r-shop",
                state: "active",
                updatedAt: "2026-11-27T09:00:00.000Z",
                setup: {
                    state: "active",
                    steps: [],
                    blockers: [],
                    requestedAt: "2026-11-27T08:00:00.000Z",
                    updatedAt: "2026-11-27T09:00:00.000Z",
                },
            } as never,
            {
                environmentId: "e2",
                repositoryId: "r-api",
                state: "blocked",
                updatedAt: "2026-11-27T10:00:00.000Z",
            },
        ]);
        expect(out.withEnvironment.map((r) => r.id)).toEqual([
            "r-api",
            "r-shop",
        ]);
        expect(out.withEnvironment.map((r) => r.status?.label)).toEqual([
            expect.any(String),
            "Ready",
        ]);
        // The rest by name, after them.
        expect(out.others.map((r) => r.name)).toEqual([
            "acme/app",
            "acme/mono",
        ]);
        expect(out.preferred).toBe("r-api");
    });

    it("with no environment at all, lists every repository by name and opens on the first", () => {
        const out = runsRepositories(repos, []);
        expect(out.withEnvironment).toEqual([]);
        expect(out.others.map((r) => r.name)).toEqual([
            "acme/api",
            "acme/app",
            "acme/mono",
            "acme/shop",
        ]);
        expect(out.preferred).toBe("r-api");
    });

    it("an environment of a repository the team no longer reviews is not listed", () => {
        const out = runsRepositories(repos.slice(0, 1), [
            { environmentId: "e1", repositoryId: "r-gone", state: "active" },
        ]);
        expect(out.withEnvironment).toEqual([]);
        expect(out.preferred).toBe("r-mono");
    });
});
