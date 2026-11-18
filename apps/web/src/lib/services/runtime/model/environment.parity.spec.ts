import { isRecipeFailureBlocker as worker } from "@libs/runtime/run/environment-setup";

import { isRecipeFailureBlocker as web } from "./environment";

// The web keeps its own copy of the rule (its isolated build takes no
// runtime code); this pins the copy to the runtime-worker's.
describe("isRecipeFailureBlocker parity with the runtime-worker", () => {
    const cases: Array<{ kind: string; signature: string } | undefined> = [
        undefined,
        { kind: "platform", signature: "setup:ClaimLeaseUnavailableError" },
        { kind: "platform", signature: "repo_fetch" },
        { kind: "cell_unavailable", signature: "cell_unavailable" },
        { kind: "setup_failed", signature: "cell_unavailable" },
        { kind: "resources", signature: "org_capacity" },
        { kind: "resources", signature: "no_capacity" },
        { kind: "resources", signature: "size_unavailable" },
        { kind: "resources", signature: "machine_minutes_exhausted" },
        { kind: "resources", signature: "out_of_memory" },
        { kind: "security_violation", signature: "canary_egress" },
        { kind: "not_ready", signature: "setup:not_ready" },
        { kind: "compose_up", signature: "compose_up:build" },
        { kind: "recipe_outdated", signature: "recipe_outdated" },
        { kind: "capacity", signature: "isolation_unavailable" },
    ];

    it.each(cases.map((c) => [JSON.stringify(c), c]))("%s", (_name, b) => {
        expect(web(b)).toBe(worker(b));
    });
});
