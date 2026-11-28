import {
    DEFAULT_FORK_PULL_REQUEST_POLICY,
    FORK_PULL_REQUEST_POLICIES,
} from "@libs/runtime/contracts/enums";

import {
    DEFAULT_FORK_POLICY,
    FORK_POLICY_OPTIONS,
    forkPolicyOption,
} from "./fork-pull-requests";

describe("fork policy parity (web ↔ libs/runtime)", () => {
    it("offers every policy of the contract, once, with the same default first", () => {
        expect([...FORK_POLICY_OPTIONS.map((o) => o.value)].sort()).toEqual(
            [...FORK_PULL_REQUEST_POLICIES].sort(),
        );
        expect(DEFAULT_FORK_POLICY).toBe(DEFAULT_FORK_PULL_REQUEST_POLICY);
        expect(FORK_POLICY_OPTIONS[0].value).toBe(DEFAULT_FORK_POLICY);
    });

    it("reads only a known policy", () => {
        expect(forkPolicyOption("run")?.label).toBe("Run without approval");
        expect(forkPolicyOption("Run")).toBeUndefined();
    });
});
