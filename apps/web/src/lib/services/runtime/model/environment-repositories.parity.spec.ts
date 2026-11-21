import {
    REPOSITORY_ALIAS_PATTERN as LIB_PATTERN,
    MAX_WORKSPACE_REPOSITORIES,
    repositoryAliasOf,
} from "@libs/runtime/contracts/workspace";

import {
    defaultRepositoryAlias,
    MAX_ENVIRONMENT_REPOSITORIES,
    REPOSITORY_ALIAS_PATTERN,
} from "./environment-repositories";

// The web keeps its own copy of the alias rules (its isolated build takes no
// runtime code); this pins the copy to libs/runtime/contracts/workspace.ts.
describe("repository alias parity with the runtime contracts", () => {
    it("is the same pattern and the same limit", () => {
        expect(REPOSITORY_ALIAS_PATTERN.source).toBe(LIB_PATTERN.source);
        expect(MAX_ENVIRONMENT_REPOSITORIES).toBe(MAX_WORKSPACE_REPOSITORIES);
    });

    it.each([
        "acme/kodus-ai",
        "acme/kodus-service-billing",
        "group/sub/My Repo!",
        "acme/__private",
        "acme/.dotfiles",
        "acme/日本",
        "acme/" + "x".repeat(80),
        "no-owner",
    ])("gives %s the default alias the API gives it", (name) => {
        expect(defaultRepositoryAlias(name)).toBe(repositoryAliasOf(name));
    });
});
