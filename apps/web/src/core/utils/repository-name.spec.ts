import { repositoryFullName, repositoryNameParts } from "./repository-name";

// #2718: GitLab and Forgejo store the full path in `name`
// (`path_with_namespace`, `full_name`); GitHub, Bitbucket and Azure Repos store
// the bare repository name next to its owner.
describe("repository names", () => {
    it.each([
        ["GitHub", { organizationName: "acme", name: "api" }, "acme/api"],
        ["Forgejo", { organizationName: "e2e", name: "e2e/repo" }, "e2e/repo"],
        [
            "GitLab subgroup",
            { organizationName: "Group", name: "group/sub/repo" },
            "group/sub/repo",
        ],
    ])("names a %s repository once", (_provider, repository, expected) => {
        expect(repositoryFullName(repository)).toBe(expected);
    });

    it("splits a stored path at its last slash", () => {
        expect(
            repositoryNameParts({
                organizationName: "Group",
                name: "group/sub/repo",
            }),
        ).toEqual({ owner: "group/sub", repo: "repo" });
        expect(
            repositoryNameParts({ organizationName: "acme", name: "api" }),
        ).toEqual({ owner: "acme", repo: "api" });
    });
});
