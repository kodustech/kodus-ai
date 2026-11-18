/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { RuntimeRunCost } from "@services/runtime/contracts";
import { render, screen } from "@testing-library/react";

import { RecipeChangedNotice, recipeChangesOf } from "./recipe-changed-notice";
import { costCaveat, RunCostBreakdown } from "./run-cost";

const cost = (patch: Partial<RuntimeRunCost> = {}): RuntimeRunCost => ({
    estimate: true,
    currency: "USD",
    llmTokens: 20_500,
    machines: {
        minutes: 10,
        vm: { instanceType: "m7i.2xlarge", count: 2, usdPerHour: 0.4032 },
        observer: { instanceType: "t3.medium", count: 2, usdPerHour: 0.0416 },
        region: "us-east-1",
        usd: 0.148267,
        paidBy: "kodus",
    },
    llm: {
        tokens: 20_500,
        usd: 0.0915,
        models: [
            {
                model: "claude-sonnet-4.5",
                inputTokens: 18_400,
                outputTokens: 2_100,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                usd: 0.0915,
            },
        ],
        unsettledTokens: 0,
    },
    totalUsd: 0.239767,
    complete: true,
    ...patch,
});

describe("RunCostBreakdown", () => {
    it("shows machines, LLM and the total as an estimate, two decimals at most", () => {
        render(<RunCostBreakdown cost={cost()} />);
        expect(screen.getByText("≈ $0.15")).toBeInTheDocument();
        expect(screen.getByText("≈ $0.09")).toBeInTheDocument();
        expect(screen.getByText("≈ $0.24")).toBeInTheDocument();
        expect(
            screen.getByText(/2 × m7i\.2xlarge \+ 2 × t3\.medium, 10 min/),
        ).toBeInTheDocument();
        expect(screen.getByText(/not a bill/)).toBeInTheDocument();
    });

    it("an unpriced part says so instead of reading as free", () => {
        const partial = cost({
            machines: { ...cost().machines, usd: null, paidBy: "customer" },
            llm: { ...cost().llm, usd: null },
            totalUsd: null,
            complete: false,
        });
        render(<RunCostBreakdown cost={partial} />);
        expect(screen.getByText("On your host")).toBeInTheDocument();
        expect(screen.getByText("Not priced")).toBeInTheDocument();
        expect(costCaveat(partial)).toMatch(
            /^Partial: machines run on your own host/,
        );
        expect(costCaveat(cost())).toBeUndefined();
    });

    // demo-shop on cell-dev-1: base at its ready size 8 min, PR at its build size 25 s then ready.
    const shared = (patch: Partial<RuntimeRunCost["machines"]> = {}) =>
        cost({
            machines: {
                ...cost().machines,
                minutes: 8,
                model: "shared_cell",
                mbMinutes: 37_034.666667,
                usd: 0.005626,
                host: {
                    cellId: "cell-dev-1",
                    instanceType: "t4g.xlarge",
                    usdPerHour: 0.1344,
                    region: "us-east-2",
                },
                ...patch,
            },
            totalUsd: 0.097126,
        });

    it("a shared cell shows the host, the memory held and its share of the host, to the tenth of a cent", () => {
        render(<RunCostBreakdown cost={shared()} />);
        expect(
            screen.getByText(
                "Kodus host t4g.xlarge · 0.60 GB·h held · list price $0.1344/h, us-east-2",
            ),
        ).toBeInTheDocument();
        expect(screen.getByText("≈ $0.006")).toBeInTheDocument();
        expect(screen.queryByText(/m7i\.2xlarge/)).not.toBeInTheDocument();
        expect(costCaveat(shared())).toBeUndefined();
    });

    it("missing facts or a cell without a price read as not priced, with the reason", () => {
        const missing = cost({
            machines: {
                ...cost().machines,
                model: "unknown",
                usd: null,
                unpriced: "missing_claim_facts",
            },
            complete: false,
        });
        const { unmount } = render(<RunCostBreakdown cost={missing} />);
        expect(
            screen.getByText("Machine time not recorded for this Run"),
        ).toBeInTheDocument();
        expect(screen.getByText("Not priced")).toBeInTheDocument();
        expect(costCaveat(missing)).toMatch(/machine time was not recorded/);
        unmount();

        const noPrice = shared({
            usd: null,
            host: undefined,
            unpriced: "cell_price_unknown",
        });
        render(<RunCostBreakdown cost={noPrice} />);
        expect(
            screen.getByText("Kodus host · 0.60 GB·h held"),
        ).toBeInTheDocument();
        expect(screen.getByText("Not priced")).toBeInTheDocument();
        expect(costCaveat(noPrice)).toMatch(/no list price configured/);
    });

    it("a customer's shared cell shows what was held, unpriced", () => {
        render(
            <RunCostBreakdown
                cost={shared({
                    paidBy: "customer",
                    usd: null,
                    host: undefined,
                })}
            />,
        );
        expect(
            screen.getByText("Your host · 0.60 GB·h held"),
        ).toBeInTheDocument();
        expect(screen.getByText("On your host")).toBeInTheDocument();
    });

    it("a customer's shared cell priced at the org's price per host-hour shows the price and its share, whole", () => {
        const own = shared({
            paidBy: "customer",
            host: undefined,
            ownHostUsdPerHour: 0.1344,
        });
        render(<RunCostBreakdown cost={own} />);
        expect(
            screen.getByText(
                "Your host · 0.60 GB·h held · your price $0.1344/h",
            ),
        ).toBeInTheDocument();
        expect(screen.getByText("≈ $0.006")).toBeInTheDocument();
        expect(costCaveat(own)).toBeUndefined();
    });

    it("an unpriced customer's shared cell says where to set a price", () => {
        const unpriced = shared({ paidBy: "customer", usd: null, host: undefined });
        expect(costCaveat(unpriced)).toBe(
            "Partial: machines run on your own host and are not counted; set a price per host-hour in Runtime settings to count them.",
        );
        // A per-VM host of the org: the price per host-hour does not apply.
        const vm = cost({
            machines: { ...cost().machines, usd: null, paidBy: "customer", model: "vm" },
        });
        expect(costCaveat(vm)).toBe(
            "Partial: machines run on your own host and are not counted.",
        );
    });
});

describe("RunCostBreakdown and the LLM usage", () => {
    it("reads not measured when the usage could not be read, never free", () => {
        const c = cost({
            llm: {
                tokens: 0,
                usd: null,
                models: [],
                unsettledTokens: 0,
                source: "not_measured",
            },
            totalUsd: 0.148267,
            complete: false,
        });
        render(<RunCostBreakdown cost={c} />);
        expect(screen.getByText("Not measured")).toBeInTheDocument();
        expect(costCaveat(c)).toBe("Partial: the LLM usage could not be read.");
    });

    it("says what the organization's own keys paid", () => {
        render(
            <RunCostBreakdown
                cost={cost({
                    llm: {
                        ...cost().llm,
                        source: "telemetry",
                        customerUsd: 0.09,
                    },
                })}
            />,
        );
        expect(screen.getByText(/on your own keys/)).toHaveTextContent(
            "≈ $0.09 on your own keys",
        );
    });
});

describe("RecipeChangedNotice (S-19)", () => {
    it("names the setup files and says the base's setup file ran", () => {
        render(
            <RecipeChangedNotice
                run={{ recipeChangedInPr: [".kodus/workspace.yaml"] }}
            />,
        );
        expect(screen.getByRole("note")).toHaveTextContent(
            "This PR changes .kodus/workspace.yaml. Kody boots every pull request with the setup file from the base branch, so the PR's copy was not tested.",
        );
    });

    it("an older Run with only the flag still warns; a Run without a change shows nothing", () => {
        expect(
            recipeChangesOf({
                recipe: { sha: "a", state: "found", prChangesRecipe: true },
            }),
        ).toEqual({ changed: true, files: [] });
        const { container } = render(<RecipeChangedNotice run={{}} />);
        expect(container).toBeEmptyDOMElement();
    });
});
