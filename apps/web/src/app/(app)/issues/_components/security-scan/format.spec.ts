import {
    cweUrl,
    formatScanCoverage,
    formatScanOutcome,
    formatScanSpend,
    formatSymbolLines,
    isNoKnownPriceMessage,
    reproductionStatus,
} from "./format";

const spend = {
    usd: 3.12,
    inputTokens: 1_000_000,
    outputTokens: 200_000,
    requests: 40,
};

describe("formatScanSpend", () => {
    it("shows USD against a USD limit", () => {
        expect(formatScanSpend({ budget: { maxUsd: 20 }, spend })).toBe(
            "$3.12 of $20",
        );
    });

    it("shows input plus output tokens against a token limit", () => {
        expect(
            formatScanSpend({ budget: { maxTokens: 2_000_000 }, spend }),
        ).toBe("1.2M of 2M tokens");
    });
});

describe("formatScanCoverage", () => {
    it("counts examined areas and names what was left out", () => {
        expect(
            formatScanCoverage({
                examinedFiles: [],
                languages: [],
                unitsTotal: 40,
                unitsDone: 38,
                unitsFailed: 0,
                unitsSkippedByBudget: 2,
            }),
        ).toBe("38/40 areas examined · 2 skipped at the limit");
    });

    it("says nothing before the scan has planned its areas", () => {
        expect(formatScanCoverage(undefined)).toBeUndefined();
    });
});

describe("formatScanOutcome", () => {
    it("lists only the non-zero counts", () => {
        expect(
            formatScanOutcome({
                created: 5,
                stillOpen: 2,
                reopened: 0,
                dismissed: 0,
                resolved: 1,
            }),
        ).toBe("5 new · 2 still open · 1 resolved");
    });

    it("says so when the scan found nothing", () => {
        expect(
            formatScanOutcome({
                created: 0,
                stillOpen: 0,
                reopened: 0,
                dismissed: 0,
                resolved: 0,
            }),
        ).toBe("No findings");
    });
});

describe("reproductionStatus", () => {
    it("reads a reproduced test as confirmed", () => {
        expect(
            reproductionStatus({
                executed: true,
                reproduced: true,
                exitCode: 1,
            }).label,
        ).toBe("Reproduced in an isolated sandbox");
    });

    it("gives the exit code when the test ran and did not reproduce", () => {
        expect(
            reproductionStatus({
                executed: true,
                reproduced: false,
                exitCode: 0,
            }).label,
        ).toBe("Ran, did not reproduce (exit 0)");
    });

    it("says the test was not run when it was not executed", () => {
        expect(reproductionStatus({ executed: false }).label).toBe(
            "Not run in this environment",
        );
    });
});

describe("formatSymbolLines", () => {
    it("joins the function and its line range", () => {
        expect(
            formatSymbolLines({
                symbol: "getUser",
                startLine: 12,
                endLine: 40,
            }),
        ).toBe("getUser (lines 12-40)");
    });

    it("uses a single line when the range is one line", () => {
        expect(
            formatSymbolLines({
                symbol: "getUser",
                startLine: 12,
                endLine: 12,
            }),
        ).toBe("getUser (line 12)");
    });
});

describe("cweUrl", () => {
    it("links a CWE id to MITRE", () => {
        expect(cweUrl("CWE-89")).toBe(
            "https://cwe.mitre.org/data/definitions/89.html",
        );
    });

    it("leaves anything else unlinked", () => {
        expect(cweUrl("OWASP A01")).toBeUndefined();
    });
});

describe("isNoKnownPriceMessage", () => {
    it("matches the API's refusal of a USD cap", () => {
        expect(
            isNoKnownPriceMessage(
                "Your model has no known price, so the scan cannot be capped in USD. Set a token limit, or add the model price to your BYOK configuration.",
            ),
        ).toBe(true);
        expect(isNoKnownPriceMessage("Repository not connected")).toBe(false);
    });
});
