import { buildResponseDiff, responseDiffChange } from "./response-diff";

describe("buildResponseDiff", () => {
    it("marks each field removed, added or changed", () => {
        const view = buildResponseDiff({
            fields: [
                { path: "json.database", base: '"ok"', pr: '"failing"' },
                { path: "json.commit", base: '"ee53311"' },
                { path: "json.error", pr: '"locked"' },
            ],
            truncated: true,
        });
        expect(view).toEqual({
            rows: [
                {
                    path: "json.database",
                    base: '"ok"',
                    pr: '"failing"',
                    change: "changed",
                },
                { path: "json.commit", base: '"ee53311"', change: "removed" },
                { path: "json.error", pr: '"locked"', change: "added" },
            ],
            truncated: true,
        });
    });

    it("draws nothing for an older Run or an empty diff", () => {
        expect(buildResponseDiff(undefined)).toBeUndefined();
        expect(
            buildResponseDiff({ fields: [], truncated: false }),
        ).toBeUndefined();
        expect(
            buildResponseDiff({ fields: [{ path: "" }], truncated: false }),
        ).toBeUndefined();
    });
});

describe("responseDiffChange", () => {
    it("is changed when both sides have a value, or neither does", () => {
        expect(responseDiffChange("1", "2")).toBe("changed");
        expect(responseDiffChange(undefined, undefined)).toBe("changed");
        expect(responseDiffChange("1", undefined)).toBe("removed");
        expect(responseDiffChange(undefined, "2")).toBe("added");
    });
});
