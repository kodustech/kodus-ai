import {
    compareRules,
    matchesOriginFilter,
    matchesSeverityFilter,
    matchesTextQuery,
    type ListFilters,
} from "../../../apps/web/src/core/utils/kody-rules/apply-filters";

const buildRule = (overrides: any = {}) => ({
    uuid: "rule-1",
    title: "Test rule",
    rule: "do something",
    severity: "medium",
    ...overrides,
});

describe("matchesOriginFilter", () => {
    it("passes every rule when no origin filter is set (empty Set)", () => {
        const filter: ListFilters = {
            origins: new Set(),
            severities: new Set(),
            withSyncErrors: false,
            pausedOnly: false,
        };
        expect(
            matchesOriginFilter(
                buildRule({ sourcePath: ".cursorrules", origin: "user" }),
                filter,
            ),
        ).toBe(true);
        expect(
            matchesOriginFilter(
                buildRule({ sourcePath: null, origin: "user" }),
                filter,
            ),
        ).toBe(true);
    });

    it("only allows Auto-sync rules through when filtering by Auto-sync", () => {
        const filter: ListFilters = {
            origins: new Set(["Auto-sync"]),
            severities: new Set(),
            withSyncErrors: false,
            pausedOnly: false,
        };
        expect(
            matchesOriginFilter(
                buildRule({ sourcePath: ".cursorrules", origin: "user" }),
                filter,
            ),
        ).toBe(true);
        expect(
            matchesOriginFilter(
                buildRule({ sourcePath: "esbuild.config.js", origin: "user" }),
                filter,
            ),
        ).toBe(false);
        expect(
            matchesOriginFilter(
                buildRule({ sourcePath: null, origin: "user" }),
                filter,
            ),
        ).toBe(false);
    });

    it("treats multiple origin selections as union (OR within section)", () => {
        const filter: ListFilters = {
            origins: new Set(["Auto-sync", "Onboard"]),
            severities: new Set(),
            withSyncErrors: false,
            pausedOnly: false,
        };
        expect(
            matchesOriginFilter(
                buildRule({ sourcePath: ".cursorrules" }),
                filter,
            ),
        ).toBe(true);
        expect(
            matchesOriginFilter(
                buildRule({ sourcePath: "esbuild.config.js" }),
                filter,
            ),
        ).toBe(true);
        expect(
            matchesOriginFilter(buildRule({ sourcePath: null }), filter),
        ).toBe(false);
    });
});

describe("matchesSeverityFilter", () => {
    it("passes every rule when no severity filter is set", () => {
        const filter: ListFilters = {
            origins: new Set(),
            severities: new Set(),
            withSyncErrors: false,
            pausedOnly: false,
        };
        expect(
            matchesSeverityFilter(buildRule({ severity: "low" }), filter),
        ).toBe(true);
        expect(
            matchesSeverityFilter(buildRule({ severity: "critical" }), filter),
        ).toBe(true);
    });

    it("matches case-insensitively against the rule severity", () => {
        const filter: ListFilters = {
            origins: new Set(),
            severities: new Set(["critical"]),
            withSyncErrors: false,
            pausedOnly: false,
        };
        expect(
            matchesSeverityFilter(buildRule({ severity: "critical" }), filter),
        ).toBe(true);
        expect(
            matchesSeverityFilter(buildRule({ severity: "Critical" }), filter),
        ).toBe(true);
        expect(
            matchesSeverityFilter(buildRule({ severity: "CRITICAL" }), filter),
        ).toBe(true);
        expect(
            matchesSeverityFilter(buildRule({ severity: "high" }), filter),
        ).toBe(false);
    });

    it("treats multiple severity selections as union (OR within section)", () => {
        const filter: ListFilters = {
            origins: new Set(),
            severities: new Set(["critical", "high"]),
            withSyncErrors: false,
            pausedOnly: false,
        };
        expect(
            matchesSeverityFilter(buildRule({ severity: "critical" }), filter),
        ).toBe(true);
        expect(
            matchesSeverityFilter(buildRule({ severity: "high" }), filter),
        ).toBe(true);
        expect(
            matchesSeverityFilter(buildRule({ severity: "medium" }), filter),
        ).toBe(false);
    });

    it("excludes rules with missing/unknown severity when the filter is active", () => {
        const filter: ListFilters = {
            origins: new Set(),
            severities: new Set(["critical"]),
            withSyncErrors: false,
            pausedOnly: false,
        };
        expect(
            matchesSeverityFilter(buildRule({ severity: undefined }), filter),
        ).toBe(false);
        expect(
            matchesSeverityFilter(buildRule({ severity: "" }), filter),
        ).toBe(false);
    });
});

describe("matchesSyncErrorsFilter", () => {
    const { matchesSyncErrorsFilter } = jest.requireActual<
        typeof import("../../../apps/web/src/core/utils/kody-rules/apply-filters")
    >("../../../apps/web/src/core/utils/kody-rules/apply-filters");

    it("passes every rule when withSyncErrors is false", () => {
        const filter: ListFilters = {
            origins: new Set(),
            severities: new Set(),
            withSyncErrors: false,
            pausedOnly: false,
        };
        expect(matchesSyncErrorsFilter({ syncErrors: undefined }, filter)).toBe(
            true,
        );
        expect(
            matchesSyncErrorsFilter({ syncErrors: [{ msg: "err" }] }, filter),
        ).toBe(true);
    });

    it("passes only rules with non-empty syncErrors when filter is on", () => {
        const filter: ListFilters = {
            origins: new Set(),
            severities: new Set(),
            withSyncErrors: true,
            pausedOnly: false,
        };
        expect(matchesSyncErrorsFilter({ syncErrors: undefined }, filter)).toBe(
            false,
        );
        expect(matchesSyncErrorsFilter({ syncErrors: [] }, filter)).toBe(false);
        expect(
            matchesSyncErrorsFilter({ syncErrors: [{ msg: "err" }] }, filter),
        ).toBe(true);
    });
});

describe("matchesPausedOnlyFilter", () => {
    const { matchesPausedOnlyFilter } = jest.requireActual<
        typeof import("../../../apps/web/src/core/utils/kody-rules/apply-filters")
    >("../../../apps/web/src/core/utils/kody-rules/apply-filters");

    const off: ListFilters = {
        origins: new Set(),
        severities: new Set(),
        withSyncErrors: false,
        pausedOnly: false,
    };
    const on: ListFilters = { ...off, pausedOnly: true };

    it("passes every rule when pausedOnly is false", () => {
        expect(matchesPausedOnlyFilter({ status: "active" }, off)).toBe(true);
        expect(matchesPausedOnlyFilter({ status: "paused" }, off)).toBe(true);
        expect(matchesPausedOnlyFilter({ status: undefined }, off)).toBe(true);
    });

    it("passes only rules whose status === 'paused' when filter is on", () => {
        expect(matchesPausedOnlyFilter({ status: "paused" }, on)).toBe(true);
        expect(matchesPausedOnlyFilter({ status: "active" }, on)).toBe(false);
        expect(matchesPausedOnlyFilter({ status: "deleted" }, on)).toBe(false);
        expect(matchesPausedOnlyFilter({ status: undefined }, on)).toBe(false);
    });
});

describe("matchesTextQuery", () => {
    it("returns true when the query is empty", () => {
        expect(matchesTextQuery({ title: "anything" }, "")).toBe(true);
    });

    it("matches the title (case-insensitive)", () => {
        expect(
            matchesTextQuery({ title: "Logging Best Practices" }, "logging"),
        ).toBe(true);
    });

    it("matches the path glob", () => {
        expect(
            matchesTextQuery({ title: "Foo", path: "src/**/*.ts" }, "src/"),
        ).toBe(true);
    });

    it("matches sourcePath", () => {
        expect(
            matchesTextQuery(
                {
                    title: "Foo",
                    sourcePath: "qantilever/.cursor/rules/logging.mdc",
                },
                "qantilever",
            ),
        ).toBe(true);
    });

    it("matches the rule body", () => {
        expect(
            matchesTextQuery(
                { title: "Foo", rule: "Use SecretStorage for credentials" },
                "secretstorage",
            ),
        ).toBe(true);
    });

    it("matches example snippets", () => {
        expect(
            matchesTextQuery(
                {
                    title: "Foo",
                    examples: [
                        { snippet: "context.secrets.store('apiKey', token)" },
                    ],
                },
                "apikey",
            ),
        ).toBe(true);
    });

    it("returns false when no field matches", () => {
        expect(matchesTextQuery({ title: "Foo" }, "bar")).toBe(false);
    });
});

describe("compareRules", () => {
    const a = {
        title: "Alpha",
        severity: "low",
        updatedAt: "2025-01-01",
        createdAt: "2024-12-01",
    };
    const b = {
        title: "Bravo",
        severity: "critical",
        updatedAt: "2026-04-25",
        createdAt: "2026-01-01",
    };
    const c = {
        title: "Charlie",
        severity: "high",
        updatedAt: "2025-06-01",
        createdAt: "2025-05-01",
    };

    it('sorts by recency when option is "recent"', () => {
        const sorted = [a, b, c].sort((x, y) => compareRules(x, y, "recent"));
        expect(sorted.map((r) => r.title)).toEqual(["Bravo", "Charlie", "Alpha"]);
    });

    it('sorts critical → low when option is "severity-desc"', () => {
        const sorted = [a, b, c].sort((x, y) =>
            compareRules(x, y, "severity-desc"),
        );
        expect(sorted.map((r) => r.title)).toEqual(["Bravo", "Charlie", "Alpha"]);
    });

    it('sorts alphabetically when option is "alphabetical"', () => {
        const sorted = [c, a, b].sort((x, y) =>
            compareRules(x, y, "alphabetical"),
        );
        expect(sorted.map((r) => r.title)).toEqual(["Alpha", "Bravo", "Charlie"]);
    });
});
