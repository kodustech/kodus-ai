import { applyRiskRule, resetRiskRule, riskRuleRows } from "./risk-rules";

const defaults = [
    {
        id: "kodus-security",
        name: "Security and permissions",
        enabled: true,
        instructions: "Auth and permissions.",
    },
];
const team = {
    id: "tenant",
    name: "Tenant isolation",
    enabled: true,
    instructions: "Data must not cross tenants.",
};

describe("riskRuleRows", () => {
    it("shows the defaults with the team's changes, then the team's rules", () => {
        const rows = riskRuleRows(
            defaults,
            [
                { id: "kodus-security", enabled: false },
                team,
                // A default Kodus no longer ships has nothing to show, even
                // when the team had edited all of it; neither has a mistyped
                // override.
                { id: "kodus-retired", enabled: false },
                {
                    id: "kodus-retired-edited",
                    name: "Old rule",
                    enabled: true,
                    instructions: "Stale wording.",
                },
                { id: "kodus-securty", enabled: false },
            ],
            ["kodus-retired-edited"],
        );
        expect(rows).toEqual([
            { ...defaults[0], enabled: false, isDefault: true, edited: false },
            { ...team, isDefault: false, edited: false },
        ]);
    });

    it("marks a default edited only when the override differs from Kodus's version", () => {
        const edited = (override: object) =>
            riskRuleRows(defaults, [
                { id: "kodus-security", enabled: true, ...override },
            ])[0].edited;
        expect(edited({ name: "Security and permissions" })).toBe(false);
        expect(edited({ instructions: "Auth and permissions." })).toBe(false);
        expect(edited({ includedFiles: [], excludedFiles: [] })).toBe(false);
        expect(edited({ name: "Auth" })).toBe(true);
        expect(edited({ instructions: "Billing auth only." })).toBe(true);
        expect(edited({ excludedFiles: ["test/**"] })).toBe(true);
    });
});

describe("applyRiskRule", () => {
    it("stores only what differs from Kodus's version of a default", () => {
        const [row] = riskRuleRows(defaults, []);
        expect(
            applyRiskRule(defaults, [team], {
                ...row,
                includedFiles: ["src/auth/**"],
            }),
        ).toEqual([
            team,
            {
                id: "kodus-security",
                enabled: true,
                includedFiles: ["src/auth/**"],
            },
        ]);
    });

    it("removes a default the team left as Kodus ships it", () => {
        expect(
            applyRiskRule(
                defaults,
                [{ id: "kodus-security", enabled: false }],
                {
                    ...defaults[0],
                    enabled: true,
                },
            ),
        ).toEqual([]);
    });

    it("replaces a team rule whole", () => {
        expect(
            applyRiskRule(defaults, [team], { ...team, enabled: false }),
        ).toEqual([{ ...team, enabled: false }]);
    });
});

describe("resetRiskRule", () => {
    it("restores Kodus's wording and keeps the rule off when the team turned it off", () => {
        expect(
            resetRiskRule(
                defaults,
                [
                    {
                        id: "kodus-security",
                        enabled: false,
                        instructions: "Ours.",
                    },
                ],
                "kodus-security",
            ),
        ).toEqual([{ id: "kodus-security", enabled: false }]);
    });
});
