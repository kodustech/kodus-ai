import { hostPriceDraft, hostPriceWords } from "./machine-host-price";

describe("the org's price per host-hour", () => {
    it("takes a US$ amount above 0 and at most 1,000, and an empty field as no price", () => {
        expect(hostPriceDraft("")).toEqual({ usdPerHour: null });
        expect(hostPriceDraft("  ")).toEqual({ usdPerHour: null });
        expect(hostPriceDraft("0.1344")).toEqual({ usdPerHour: 0.1344 });
        expect(hostPriceDraft("$0.50")).toEqual({ usdPerHour: 0.5 });
        expect(hostPriceDraft("1000")).toEqual({ usdPerHour: 1000 });
    });

    it.each(["0", "-1", "1000.01", "cheap", "1e3x"])(
        "refuses %s and says why",
        (draft) => {
            expect(hostPriceDraft(draft)).toEqual({
                usdPerHour: null,
                error: "Enter a price above $0 and at most $1,000.",
            });
        },
    );

    it("says whether the org's own hosts are priced, and at what", () => {
        expect(hostPriceWords(null)).toBe(
            "Not set: machine time on your own hosts is not priced.",
        );
        expect(hostPriceWords(0.1344)).toBe(
            "Machine time on your own hosts is priced at $0.1344 per host-hour.",
        );
    });
});
