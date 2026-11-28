import { runsRepositories } from "./runs-repositories";

const repos = [
    { id: "r-mono", name: "acme/mono" },
    { id: "r-app", name: "acme/app" },
    { id: "r-shop", name: "acme/shop" },
    { id: "r-api", name: "acme/api" },
];

const at = "2026-11-27T08:00:00.000Z";

describe("runsRepositories", () => {
    it("offers the repositories with an environment, changed last first, with their state, and opens on the first of them", () => {
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
                    requestedAt: at,
                    updatedAt: at,
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
        expect(out.withEnvironment[1].status?.label).toBe("Ready");
        expect(out.preferred).toBe("r-api");
        // The rest are not offered for Runs; they stay apart for the screens that say what could be set up.
        expect(out.others.map((r) => r.name)).toEqual([
            "acme/app",
            "acme/mono",
        ]);
    });

    it("with no environment at all, offers nothing to open: there are no Runs to show", () => {
        const out = runsRepositories(repos, []);
        expect(out.withEnvironment).toEqual([]);
        expect(out.preferred).toBeUndefined();
    });

    it("an environment of a repository the team no longer reviews is not offered", () => {
        const out = runsRepositories(repos.slice(0, 1), [
            { environmentId: "e1", repositoryId: "r-gone", state: "active" },
        ]);
        expect(out.withEnvironment).toEqual([]);
        expect(out.preferred).toBeUndefined();
    });
});
