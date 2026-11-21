import { heldForkPolicyNote } from "./fork-pull-requests";

describe("the fork policy an environment actually applies", () => {
    it("explains that forks wait for a maintainer when an environment of several repositories is set to run them", () => {
        expect(heldForkPolicyNote("run", "require_approval")).toMatch(
            /wait for a maintainer/i,
        );
    });

    it("says nothing when the stored policy is the one that applies", () => {
        expect(heldForkPolicyNote("run", "run")).toBeUndefined();
        expect(heldForkPolicyNote("skip", "skip")).toBeUndefined();
        expect(heldForkPolicyNote("run", undefined)).toBeUndefined();
    });
});
