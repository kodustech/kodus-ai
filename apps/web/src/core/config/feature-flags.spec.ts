import { isReleasedTo } from "./feature-flags";

describe("whether an entry behind a catalog flag is shown", () => {
    it("an entry behind no flag is always shown", () => {
        expect(isReleasedTo(undefined, {})).toBe(true);
    });

    it("an entry behind kodyRuntime is shown only when the org's flag is on", () => {
        expect(isReleasedTo("kodyRuntime", { kodyRuntime: true })).toBe(true);
        expect(isReleasedTo("kodyRuntime", { kodyRuntime: false })).toBe(false);
        // Flags not loaded yet (or a failed check) hide it.
        expect(isReleasedTo("kodyRuntime", {})).toBe(false);
    });
});
