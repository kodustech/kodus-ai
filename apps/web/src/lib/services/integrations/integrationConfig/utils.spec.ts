import { selectedRepositoriesFrom } from "./utils";

const repositories = {
    configKey: "repositories",
    configValue: [{ id: "81411676", name: "group/app" }],
};
const webhookFailures = {
    configKey: "webhook_creation_failures",
    configValue: { failures: {}, startedAt: "2026-10-27T17:18:22.656Z" },
};

describe("selectedRepositoriesFrom", () => {
    it("reads the repositories config when another config comes first", () => {
        expect(
            selectedRepositoriesFrom([webhookFailures, repositories]),
        ).toEqual(repositories.configValue);
    });

    it("reads the repositories config when it comes first", () => {
        expect(
            selectedRepositoriesFrom([repositories, webhookFailures]),
        ).toEqual(repositories.configValue);
    });

    it("returns no repositories when the team has none saved", () => {
        expect(selectedRepositoriesFrom([webhookFailures])).toEqual([]);
        expect(selectedRepositoriesFrom([])).toEqual([]);
        expect(selectedRepositoriesFrom(undefined)).toEqual([]);
    });
});
