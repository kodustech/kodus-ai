import {
    clearSelection,
    getSelectAllState,
    pruneSelection,
    selectAll,
    toggleRuleSelection,
} from "../../../apps/web/src/core/utils/kody-rules/bulk-selection";

describe("toggleRuleSelection", () => {
    it("adds a missing id and removes a present one", () => {
        const initial = new Set<string>(["a"]);
        const afterAdd = toggleRuleSelection(initial, "b");
        expect(Array.from(afterAdd).sort()).toEqual(["a", "b"]);

        const afterRemove = toggleRuleSelection(afterAdd, "a");
        expect(Array.from(afterRemove)).toEqual(["b"]);
    });

    it("never mutates the input set", () => {
        const initial = new Set<string>(["a"]);
        toggleRuleSelection(initial, "b");
        expect(Array.from(initial)).toEqual(["a"]);
    });
});

describe("selectAll", () => {
    it("union of current selection and eligible ids", () => {
        const result = selectAll(new Set(["a"]), ["b", "c"]);
        expect(Array.from(result).sort()).toEqual(["a", "b", "c"]);
    });

    it("is idempotent for already-selected ids", () => {
        const result = selectAll(new Set(["a", "b"]), ["b", "c"]);
        expect(Array.from(result).sort()).toEqual(["a", "b", "c"]);
    });
});

describe("clearSelection", () => {
    it("returns a fresh empty set", () => {
        const empty = clearSelection();
        expect(empty.size).toBe(0);
        // Mutating the result must not affect any "shared" baseline.
        empty.add("x");
        expect(clearSelection().size).toBe(0);
    });
});

describe("getSelectAllState", () => {
    it('returns "none" when eligible list is empty', () => {
        expect(getSelectAllState(new Set(["a"]), [])).toBe("none");
    });

    it('returns "all" when every eligible id is selected', () => {
        expect(getSelectAllState(new Set(["a", "b"]), ["a", "b"])).toBe("all");
    });

    it('returns "some" for partial selection', () => {
        expect(getSelectAllState(new Set(["a"]), ["a", "b", "c"])).toBe("some");
    });

    it('returns "none" when no eligible id is selected, even if other ids are', () => {
        expect(
            getSelectAllState(new Set(["unrelated"]), ["a", "b"]),
        ).toBe("none");
    });
});

describe("pruneSelection", () => {
    it("drops selected ids that are no longer eligible", () => {
        const result = pruneSelection(
            new Set(["a", "b", "stale"]),
            ["a", "b", "c"],
        );
        expect(Array.from(result).sort()).toEqual(["a", "b"]);
    });

    it("returns an empty set when no eligible id remains selected", () => {
        const result = pruneSelection(new Set(["x", "y"]), ["a", "b"]);
        expect(result.size).toBe(0);
    });
});
