import { applyRiskRule, resetRiskRule, riskRuleRows } from "./risk-rules";

jest.mock(
    "@libs/core/infrastructure/config/types/general/risk-rule-ids",
    () => ({ RETIRED_KODUS_RISK_RULE_IDS: ["kodus-retired-edited"] }),
);

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
        const rows = riskRuleRows(defaults, [
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
        ]);
        expect(rows).toEqual([
            { ...defaults[0], enabled: false, isDefault: true, edited: false },
            { ...team, isDefault: false, edited: false },
        ]);
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
