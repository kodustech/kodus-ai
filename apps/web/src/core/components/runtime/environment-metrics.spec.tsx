/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";

import { EnvironmentMetrics } from "./environment-metrics";

const card = (label: string) => screen.getByText(label).parentElement!;

describe("EnvironmentMetrics", () => {
    it("shows the Runs' numbers and holds them to the targets", () => {
        render(
            <EnvironmentMetrics
                metrics={{
                    bootRate7d: 0.5,
                    readyP50Ms: 60_000,
                    readyP90Ms: 120_000,
                    runs7d: 4,
                    setupBoots: { boots7d: 2, bootRate7d: 1, readyP50Ms: 600_000, readyP90Ms: 600_000 },
                }}
            />,
        );
        expect(card("Boot success (7d)")).toHaveTextContent("50%");
        expect(screen.getByText("50%")).toHaveClass("text-warning");
        expect(card("Time to ready (p50)")).toHaveTextContent("1 min 00 s");
        expect(screen.getByText(/Target under/)).toBeInTheDocument();
        expect(screen.queryByText(/setups? this week/)).not.toBeInTheDocument();
    });

    it("with no Run booted this week, shows the setups' numbers, says so, and does not hold them to the Run targets", () => {
        render(
            <EnvironmentMetrics
                metrics={{
                    runs7d: 0,
                    setupBoots: { boots7d: 3, bootRate7d: 2 / 3, readyP50Ms: 300_000, readyP90Ms: 600_000 },
                }}
            />,
        );
        expect(card("Boot success (7d)")).toHaveTextContent("67%");
        expect(screen.getByText("67%")).not.toHaveClass("text-warning");
        expect(card("Time to ready (p50)")).toHaveTextContent("5 min 00 s");
        expect(card("Time to ready (p90)")).toHaveTextContent("10 min 00 s");
        expect(screen.getByText("10 min 00 s")).not.toHaveClass("text-warning");
        expect(screen.getAllByText(/From 3 setups this week/)).toHaveLength(2);
        expect(screen.getByText(/not held to the Run target/)).toBeInTheDocument();
    });

    it("with neither, every card is a dash", () => {
        render(<EnvironmentMetrics metrics={{ runs7d: 0 }} />);
        expect(card("Boot success (7d)")).toHaveTextContent("—");
        expect(card("Time to ready (p50)")).toHaveTextContent("—");
        expect(card("Time to ready (p90)")).toHaveTextContent("—");
    });
});
