import {
    cweUrl,
    formatOwner,
    formatScanCoverage,
    formatScanOutcome,
    formatScanSpend,
    formatSymbolLines,
    isNoKnownPriceMessage,
    parseScanLimit,
    reproductionStatus,
} from "./format";

const spend = {
    usd: 3.12,
    inputTokens: 1_000_000,
    outputTokens: 200_000,
    requests: 40,
};

describe("formatScanSpend", () => {
    it("shows tokens for a model with no known price, never $0", () => {
        expect(
            formatScanSpend({
                budget: {},
                spend: {
                    usd: 0,
                    inputTokens: 1_000_000,
                    outputTokens: 200_000,
                    requests: 40,
                },
            }),
        ).toBe("1.2M tokens");
    });

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

    it("says what the plan could not hold, so a completed scan is not read as full", () => {
        expect(
            formatScanCoverage({
                examinedFiles: [],
                languages: ["typescript", "python"],
                unitsTotal: 2000,
                unitsDone: 2000,
                unitsFailed: 0,
                unitsSkippedByBudget: 0,
                filesBeyondPlan: 1,
                mapFailedLanguages: ["python"],
            }),
        ).toBe(
            "2000/2000 areas examined · 1 file past the plan's limit not examined · could not map python files",
        );
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
    it("does not infer an execution outcome from missing legacy flags", () => {
        for (const record of [{}, { reproduced: true }, { executed: true }]) {
            expect(reproductionStatus(record)).toEqual({
                label: "Reproduction status not recorded",
                tone: "neutral",
            });
        }
    });
    it("reads a reproduced test as confirmed", () => {
        expect(
            reproductionStatus({
                executed: true,
                reproduced: true,
                exitCode: 1,
            }).label,
        ).toBe("Reproduced in an isolated sandbox");
    });

    it("offers a test that did not reproduce here as one to run, not as a verdict", () => {
        expect(
            reproductionStatus({
                executed: true,
                reproduced: false,
                exitCode: 1,
            }),
        ).toEqual({ label: "Reproduction test to run", tone: "neutral" });
        expect(reproductionStatus({ executed: false }).label).toBe(
            "Reproduction test to run",
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

describe("scan limit input", () => {
    it.each(["20usd", "1e", "Infinity", "-1", "0"])(
        "refuses %s instead of starting an uncapped scan",
        (raw) => {
            expect(parseScanLimit(raw, "usd").error).toBeTruthy();
            expect(parseScanLimit(raw, "tokens").error).toBeTruthy();
        },
    );
    it("allows only an intentionally empty limit or valid numbers", () => {
        expect(parseScanLimit("", "usd")).toEqual({});
        expect(parseScanLimit("20", "usd")).toEqual({ value: 20 });
        expect(parseScanLimit("12.50", "usd")).toEqual({ value: 12.5 });
        expect(parseScanLimit("1000", "tokens")).toEqual({ value: 1000 });
        expect(parseScanLimit("1.5", "tokens").error).toBeTruthy();
    });
});

describe("formatOwner", () => {
    it("shows a handle with one at sign, however it was stored", () => {
        expect(
            formatOwner({ gitId: "", username: "@jane", origin: "codeowners" }),
        ).toBe("@jane");
        expect(
            formatOwner({ gitId: "1", username: "jane", origin: "pr_author" }),
        ).toBe("@jane");
    });

    it("shows an email CODEOWNERS entry as the email, not its local part as a handle", () => {
        expect(
            formatOwner({
                gitId: "",
                username: "jane",
                email: "jane@acme.io",
                origin: "codeowners",
            }),
        ).toBe("jane@acme.io");
    });

    it("shows an owner stored without an origin as stored", () => {
        expect(formatOwner({ gitId: "", username: "Jane Doe" })).toBe(
            "Jane Doe",
        );
    });

    it("shows a last author by name, without an at sign", () => {
        expect(
            formatOwner({
                gitId: "",
                username: "Jane Doe",
                email: "jane@acme.io",
                origin: "last_author",
            }),
        ).toBe("Jane Doe");
    });
});

describe("deep scan v2 wording", () => {
    it("says how many files an incremental scan left unchanged", () => {
        expect(
            formatScanCoverage({
                unitsTotal: 10,
                unitsDone: 10,
                unitsFailed: 0,
                unitsSkippedByBudget: 0,
                examinedFiles: [],
                languages: [],
                unchangedFiles: 42,
            }),
        ).toBe(
            "10/10 areas examined · 42 files unchanged since an earlier scan",
        );
    });

    it("counts what verification refuted and what was folded as duplicates", () => {
        expect(
            formatScanOutcome({
                created: 3,
                stillOpen: 0,
                reopened: 0,
                dismissed: 0,
                resolved: 0,
                refuted: 5,
                consolidated: 2,
            }),
        ).toBe("3 new · 5 refuted on verification · 2 folded as duplicates");
    });

    it("reads a test that never reached the code as a test to run, not a verdict", () => {
        expect(
            reproductionStatus({
                executed: true,
                inconclusive: true,
                exitCode: 127,
            }),
        ).toEqual({
            label: "Could not run in the sandbox: a test to run",
            tone: "neutral",
        });
    });
});
