/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { RuntimeUsageReport } from "@services/runtime/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { RuntimeCostBlock } from "./usage-cost";

type Patch = {
    counts?: Partial<RuntimeUsageReport["counts"]>;
    pricing?: Partial<RuntimeUsageReport["pricing"]>;
    perCompleteRun?: RuntimeUsageReport["cost"]["perRun"]["perCompleteRun"];
    byConsumer?: Array<Record<string, unknown>>;
};

/** Only what the cost block reads. */
const report = (p: Patch = {}) =>
    ({
        month: "2026-10",
        counts: { runs: 12, runsListed: 12, prs: 8, ...p.counts },
        machine: { byConsumer: p.byConsumer ?? [] },
        cost: {
            perRun: {
                runs: 12,
                completeRuns: 10,
                pricedUsd: 4,
                unpricedParts: { machines: 2, llm: 0, total: 2 },
                perCompleteRun:
                    "perCompleteRun" in p
                        ? p.perCompleteRun
                        : {
                              medianUsd: 0.31,
                              maxUsd: 1.92,
                              medianMachinesUsd: 0.07,
                              medianLlmManagedUsd: 0.2,
                              medianLlmByokUsd: 0.04,
                          },
            },
        },
        pricing: {
            hosts: [
                {
                    instanceType: "t4g.xlarge",
                    usdPerHour: 0.1344,
                    region: "us-east-2",
                },
            ],
            ownHostUsdPerHour: null,
            effectiveUsdPerGbHour: 0.0093,
            llmModels: [
                {
                    model: "model-a",
                    paidBy: "kodus",
                    totalTokens: 2_000_000,
                    inputTokens: 1_900_000,
                    outputTokens: 100_000,
                    aboveBaseTierTokens: 500_000,
                    usd: 4,
                    usdPerMillionTokens: 2,
                },
                {
                    model: "model-b",
                    paidBy: "customer",
                    totalTokens: 1_000_000,
                    inputTokens: 900_000,
                    outputTokens: 100_000,
                    aboveBaseTierTokens: 0,
                    usd: 1,
                    usdPerMillionTokens: 1,
                },
            ],
            ...p.pricing,
        },
    }) as unknown as RuntimeUsageReport;

const section = (name: string) => screen.getByRole("region", { name });

describe("how Runs are priced", () => {
    it("names the host and its list price per hour, the rate per GB·h it implies, and says vCPU and disk are not priced", () => {
        render(<RuntimeCostBlock report={report()} />);
        const s = section("How Runs are priced");
        expect(s).toHaveTextContent("t4g.xlarge");
        expect(s).toHaveTextContent("$0.1344/h");
        expect(s).toHaveTextContent("$0.0093 per GB·h");
        expect(s).toHaveTextContent("vCPU: not priced separately (shared host)");
        expect(s).toHaveTextContent("Disk: not measured");
    });

    it("gives each model's price per 1M tokens, managed apart from your own keys, with the tier note", () => {
        render(<RuntimeCostBlock report={report()} />);
        const s = section("How Runs are priced");
        const managed = within(s).getByText("model-a").closest("li")!;
        expect(managed).toHaveTextContent("Kodus keys (managed)");
        expect(managed).toHaveTextContent("$2.00 per 1M tokens");
        expect(managed).toHaveTextContent("500K tokens priced at a higher tier");
        const byok = within(s).getByText("model-b").closest("li")!;
        expect(byok).toHaveTextContent("Your own keys (BYOK)");
        expect(byok).toHaveTextContent("$1.00 per 1M tokens");
    });

    it("says what is not counted, so the total reads as a lower bound", () => {
        render(<RuntimeCostBlock report={report()} />);
        const s = section("How Runs are priced");
        expect(s).toHaveTextContent(/idle host/i);
        expect(s).toHaveTextContent(/warm pool/i);
        expect(s).toHaveTextContent(/egress/i);
        expect(s).toHaveTextContent(/lower bound/i);
        expect(s).toHaveTextContent(/not a price you pay/i);
    });

    it("shows a price that does not exist as not set, with where it would come from, never a number", () => {
        render(
            <RuntimeCostBlock
                report={report({
                    pricing: {
                        hosts: [],
                        effectiveUsdPerGbHour: null,
                        llmModels: [
                            {
                                model: "in-house",
                                paidBy: "kodus",
                                totalTokens: 10,
                                inputTokens: 10,
                                outputTokens: 0,
                                aboveBaseTierTokens: 0,
                                usd: null,
                                usdPerMillionTokens: null,
                            },
                        ],
                    },
                })}
            />,
        );
        const s = section("How Runs are priced");
        expect(s).toHaveTextContent("Host price: not set");
        expect(s).toHaveTextContent("Runtime cell price list");
        expect(s).toHaveTextContent("Rate per GB·h: not set");
        expect(s).toHaveTextContent("not set: the price list has no price for this model");
    });

    it("prices the org's own host at the price it set in Runtime settings", () => {
        render(
            <RuntimeCostBlock
                report={report({
                    pricing: { hosts: [], ownHostUsdPerHour: 0.5 },
                })}
            />,
        );
        expect(section("How Runs are priced")).toHaveTextContent(
            "Your host: $0.50/h, the price you set in Runtime settings",
        );
    });
});

describe("the cost of a Run", () => {
    it("shows the median and the max, machines apart from LLM and own keys apart from managed, and how many Runs were priced in full", () => {
        render(<RuntimeCostBlock report={report()} />);
        const s = section("Cost of a Run");
        expect(s).toHaveTextContent("$0.31");
        expect(s).toHaveTextContent("max $1.92");
        expect(s).toHaveTextContent("Machines $0.07");
        expect(s).toHaveTextContent("LLM, Kodus keys $0.20");
        expect(s).toHaveTextContent("LLM, your own keys $0.04");
        expect(s).toHaveTextContent("10 of 12 Runs priced in full");
        expect(s).toHaveTextContent(/estimated cost at list price/i);
    });

    it("says not measured when no Run was priced in full, never a zero", () => {
        render(
            <RuntimeCostBlock report={report({ perCompleteRun: null })} />,
        );
        const s = section("Cost of a Run");
        expect(s).toHaveTextContent("Not measured");
        expect(s).not.toHaveTextContent("$0.00");
    });
});

describe("what would a month cost", () => {
    const calc = () => section("What would a month cost?");
    const field = (name: string) =>
        within(calc()).getByLabelText(name) as HTMLInputElement;

    it("starts from the org's own month: its PRs, its Runs per PR and its median Run, and says it is an estimate", () => {
        render(<RuntimeCostBlock report={report()} />);
        expect(field("PRs per month").value).toBe("8");
        expect(field("Runs per PR").value).toBe("1.5");
        expect(field("Cost per Run, in US$").value).toBe("0.31");
        // 8 PRs × 1.5 Runs × $0.31
        expect(calc()).toHaveTextContent("Estimated cost: $3.72 a month");
        expect(calc()).toHaveTextContent(/an estimate at list price/i);
        expect(calc()).toHaveTextContent(/not a price you pay/i);
    });

    it("follows what the admin types", () => {
        render(<RuntimeCostBlock report={report()} />);
        fireEvent.change(field("PRs per month"), { target: { value: "200" } });
        expect(calc()).toHaveTextContent("Estimated cost: $93.00 a month");
        fireEvent.change(field("Cost per Run, in US$"), {
            target: { value: "0.5" },
        });
        expect(calc()).toHaveTextContent("Estimated cost: $150.00 a month");
    });

    it("shows what 100, 300 and 1000 PRs would cost at the same Runs per PR and cost per Run", () => {
        render(<RuntimeCostBlock report={report()} />);
        expect(calc()).toHaveTextContent("100 PRs $46.50");
        expect(calc()).toHaveTextContent("300 PRs $139.50");
        expect(calc()).toHaveTextContent("1,000 PRs $465.00");
    });

    it("gives the machine time of setups and previews of the month on a line of its own, not in the estimate", () => {
        render(
            <RuntimeCostBlock
                report={report({
                    byConsumer: [
                        {
                            consumer: "setup",
                            side: "setup",
                            claims: 3,
                            gbMinutes: 30,
                            hostUsd: 0.02,
                        },
                        {
                            consumer: "preview",
                            side: "pr",
                            claims: 1,
                            gbMinutes: 10,
                            hostUsd: 0.01,
                        },
                    ],
                })}
            />,
        );
        expect(calc()).toHaveTextContent(
            "Setups and previews in 2026-10: 40 GB·min of machine time, about $0.03, not in the estimate above",
        );
    });

    it("has no estimate, and says so, while an input is empty or the org has no priced Run to start from", () => {
        render(
            <RuntimeCostBlock
                report={report({
                    counts: { runs: 0, runsListed: 0, prs: 0 },
                    perCompleteRun: null,
                })}
            />,
        );
        expect(field("PRs per month").value).toBe("");
        expect(field("Cost per Run, in US$").value).toBe("");
        expect(calc()).toHaveTextContent(
            "Fill in the three numbers to see an estimate",
        );
        expect(calc()).not.toHaveTextContent("Estimated cost:");
    });
});
