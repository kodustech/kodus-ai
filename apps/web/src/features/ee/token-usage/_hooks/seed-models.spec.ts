import { seedSelectedModels } from "./seed-models";

describe("seedSelectedModels", () => {
    const available = ["gpt-4o", "gemini-2.5-flash", "kimi-k2.7-code"];

    it("selects all models when there is no `?models=` param", () => {
        expect(seedSelectedModels(null, available)).toEqual(available);
        expect(seedSelectedModels(undefined, available)).toEqual(available);
        expect(seedSelectedModels("", available)).toEqual(available);
    });

    it("scopes to a single deep-linked model (the BYOK chip case)", () => {
        expect(seedSelectedModels("gpt-4o", available)).toEqual(["gpt-4o"]);
    });

    it("scopes to a comma-separated subset and trims whitespace", () => {
        expect(
            seedSelectedModels("gpt-4o, gemini-2.5-flash", available),
        ).toEqual(["gpt-4o", "gemini-2.5-flash"]);
    });

    it("drops ids that are not in the available aggregation", () => {
        expect(seedSelectedModels("gpt-4o,not-a-model", available)).toEqual([
            "gpt-4o",
        ]);
    });

    it("falls back to all models when nothing valid survives (never empty)", () => {
        // An empty selection is read by the UI as "All models"; returning all
        // here keeps the deep-link honest instead of showing an empty screen.
        expect(seedSelectedModels("stale-model", available)).toEqual(available);
    });

    it("returns a fresh array (does not alias the available list)", () => {
        const result = seedSelectedModels(null, available);
        expect(result).not.toBe(available);
        expect(result).toEqual(available);
    });
});
