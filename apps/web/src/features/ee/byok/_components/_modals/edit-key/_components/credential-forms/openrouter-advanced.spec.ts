import { parseProviderOrder } from "./openrouter-advanced";

/**
 * The pin field documents comma-separated names and could not accept a comma.
 *
 * The input is controlled and its displayed value was derived from the parsed
 * `string[]`. A person types a STRING, and the two disagree mid-word: "baseten,"
 * parses to ["baseten"] — the empty segment after the separator is dropped — and
 * re-renders as "baseten", erasing the comma in the same keystroke that typed
 * it. The separator was untypeable, so a second provider could never be entered.
 *
 * `parseProviderOrder` still normalises; what changed is that it no longer feeds
 * the display while the field has focus. These pin the normalisation, then the
 * round-trip that shows why deriving the display from it cannot work.
 */
describe("parseProviderOrder", () => {
    it.each([
        ["one name", "baseten/fp4", ["baseten/fp4"]],
        ["two names", "baseten/fp4, together", ["baseten/fp4", "together"]],
        ["padding around names", "  a ,  b  ", ["a", "b"]],
        ["a trailing separator", "a,", ["a"]],
        ["repeated separators", "a,,b", ["a", "b"]],
    ])("reads %s", (_label, raw, expected) => {
        expect(parseProviderOrder(raw)).toEqual(expected);
    });

    it.each([
        ["an empty field", ""],
        ["only whitespace", "   "],
        ["only separators", ",,,"],
    ])("returns null for %s — no pin, not an empty pin", (_label, raw) => {
        // null is what the write path treats as "leave OpenRouter's own routing
        // alone"; an empty array would persist as a meaningless setting.
        expect(parseProviderOrder(raw)).toBeNull();
    });

    it("cannot round-trip a half-typed separator — why the draft exists", () => {
        // THE bug, stated as the property that fails. Feeding this back into the
        // input is what deleted the user's comma on every keystroke.
        const typed = "baseten/fp4,";
        const shownIfDerived = (parseProviderOrder(typed) ?? []).join(", ");

        expect(shownIfDerived).toBe("baseten/fp4");
        expect(shownIfDerived).not.toBe(typed);

        // Same for the space a person types after the comma.
        const typedWithSpace = "baseten/fp4, ";
        expect((parseProviderOrder(typedWithSpace) ?? []).join(", ")).not.toBe(
            typedWithSpace,
        );
    });
});
