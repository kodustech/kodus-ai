import { hostOf, planAccountChanged } from "./plan-account";

// Real Moonshot plan endpoints — the exact case that motivated the fix.
const DEVELOPER = "https://api.moonshot.ai/anthropic";
const CODE_PLAN = "https://api.kimi.com/coding";

describe("hostOf", () => {
    it.each([
        [DEVELOPER, "api.moonshot.ai"],
        [CODE_PLAN, "api.kimi.com"],
        ["https://api.moonshot.ai/v1/models", "api.moonshot.ai"],
    ])("%s → %s", (url, host) => {
        expect(hostOf(url)).toBe(host);
    });

    it.each([[undefined], [null], [""], ["not a url"]])(
        "empty/unparseable (%s) → undefined",
        (bad) => {
            expect(hostOf(bad as any)).toBeUndefined();
        },
    );
});

describe("planAccountChanged — the key-reuse gate", () => {
    it("switching Developer API → Code Plan is a different account (needs a new key)", () => {
        expect(planAccountChanged(true, DEVELOPER, CODE_PLAN)).toBe(true);
    });

    it("same endpoint host → reuse the stored key (false)", () => {
        expect(planAccountChanged(true, DEVELOPER, DEVELOPER)).toBe(false);
        // Same host, different path (e.g. /anthropic vs /v1) is still one account.
        expect(
            planAccountChanged(
                true,
                DEVELOPER,
                "https://api.moonshot.ai/v1",
            ),
        ).toBe(false);
    });

    it("a fresh add (not editing) never forces a new key", () => {
        expect(planAccountChanged(false, DEVELOPER, CODE_PLAN)).toBe(false);
    });

    it("unknown endpoints → no false positive (reuse stays allowed)", () => {
        expect(planAccountChanged(true, undefined, CODE_PLAN)).toBe(false);
        expect(planAccountChanged(true, DEVELOPER, undefined)).toBe(false);
        expect(planAccountChanged(true, "", "")).toBe(false);
    });
});
