import {
    applyFiltersToParams,
    EMPTY_SERIALIZED,
    parseFiltersFromParams,
} from "../../../apps/web/src/core/utils/kody-rules/serialize-filters";

describe("parseFiltersFromParams", () => {
    it("returns empty filters when no params are provided", () => {
        expect(parseFiltersFromParams(null)).toEqual(EMPTY_SERIALIZED);
        expect(parseFiltersFromParams(new URLSearchParams())).toEqual(
            EMPTY_SERIALIZED,
        );
    });

    it("parses query, origins, severities and onlyOrphans correctly", () => {
        const params = new URLSearchParams(
            "q=logging&origins=Auto-sync,Onboard&severities=critical,high&onlyOrphans=1",
        );
        const result = parseFiltersFromParams(params);

        expect(result.query).toBe("logging");
        expect(Array.from(result.listFilters.origins).sort()).toEqual([
            "Auto-sync",
            "Onboard",
        ]);
        expect(Array.from(result.listFilters.severities).sort()).toEqual([
            "critical",
            "high",
        ]);
        expect(result.onlyOrphans).toBe(true);
    });

    it("ignores unknown origin and severity values silently (defensive parsing)", () => {
        const params = new URLSearchParams(
            "origins=Auto-sync,bogus,manual&severities=critical,super-bad",
        );
        const result = parseFiltersFromParams(params);

        expect(Array.from(result.listFilters.origins).sort()).toEqual([
            "Auto-sync",
            "manual",
        ]);
        expect(Array.from(result.listFilters.severities)).toEqual(["critical"]);
    });

    it("normalizes severity casing", () => {
        const params = new URLSearchParams("severities=CRITICAL,High");
        const result = parseFiltersFromParams(params);
        expect(Array.from(result.listFilters.severities).sort()).toEqual([
            "critical",
            "high",
        ]);
    });
});

describe("applyFiltersToParams", () => {
    it("writes only the params that have a non-empty value (clean URL)", () => {
        const params = new URLSearchParams();
        applyFiltersToParams(params, {
            query: "auth",
            listFilters: {
                origins: new Set(["Auto-sync"]),
                severities: new Set(["high"]),
                withSyncErrors: true,
            },
            onlyOrphans: true,
        });

        expect(params.toString()).toBe(
            "q=auth&origins=Auto-sync&severities=high&onlyOrphans=1&syncErrors=1",
        );
    });

    it("removes params when filters become empty", () => {
        const params = new URLSearchParams(
            "q=x&origins=Auto-sync&severities=low&onlyOrphans=1",
        );
        applyFiltersToParams(params, EMPTY_SERIALIZED);

        expect(params.toString()).toBe("");
    });

    it("preserves unrelated params (e.g. tab=memories)", () => {
        const params = new URLSearchParams("tab=memories&directoryId=abc");
        applyFiltersToParams(params, {
            query: "x",
            listFilters: {
                origins: new Set(),
                severities: new Set(),
                withSyncErrors: false,
            },
            onlyOrphans: false,
        });

        expect(params.get("tab")).toBe("memories");
        expect(params.get("directoryId")).toBe("abc");
        expect(params.get("q")).toBe("x");
    });

    it("round-trips parse → apply → parse", () => {
        const params = new URLSearchParams(
            "q=logging&origins=Onboard&severities=critical,low&onlyOrphans=1",
        );
        const parsed = parseFiltersFromParams(params);

        const fresh = new URLSearchParams();
        applyFiltersToParams(fresh, parsed);

        const reparsed = parseFiltersFromParams(fresh);
        expect(reparsed.query).toBe(parsed.query);
        expect(Array.from(reparsed.listFilters.origins).sort()).toEqual(
            Array.from(parsed.listFilters.origins).sort(),
        );
        expect(Array.from(reparsed.listFilters.severities).sort()).toEqual(
            Array.from(parsed.listFilters.severities).sort(),
        );
        expect(reparsed.onlyOrphans).toBe(parsed.onlyOrphans);
    });
});
