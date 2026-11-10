/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen } from "@testing-library/react";
import type { CreditAutoTopUp } from "src/features/ee/subscription/_services/billing/types";

import { AutoTopUpMonthlyLimit } from "./auto-topup-monthly-limit";

const auto: CreditAutoTopUp = {
    enabled: true,
    thresholdUsd: 5,
    amountUsd: 50,
    paymentMethod: "Visa •••• 4242",
    lastAt: null,
    lastError: null,
    monthlyLimitUsd: 100,
    monthlyPurchasedUsd: 50,
    monthlyReservedUsd: 0,
    monthlyRemainingUsd: 50,
    monthlyLimitReached: false,
    resetsAt: "2027-01-01T00:00:00.000Z",
};

describe("monthly auto top-up limit", () => {
    it("saves a numeric cap, zero to pause, and null to remove the cap", () => {
        const save = jest.fn();
        render(
            <AutoTopUpMonthlyLimit
                auto={auto}
                disabled={false}
                onSave={save}
            />,
        );
        const input = screen.getByRole("spinbutton", {
            name: /monthly auto top-up limit/i,
        });
        expect(
            screen.getByRole("button", { name: "Save limit" }),
        ).toBeDisabled();
        for (const [value, expected] of [
            ["200", 200],
            ["0", 0],
            ["", null],
        ] as const) {
            fireEvent.change(input, { target: { value } });
            fireEvent.click(screen.getByRole("button", { name: "Save limit" }));
            expect(save).toHaveBeenLastCalledWith(expected);
        }
    });

    it.each(["-1", "1.5", "100000000"])(
        "prevents saving invalid cap %s",
        (value) => {
            const save = jest.fn();
            render(
                <AutoTopUpMonthlyLimit
                    auto={auto}
                    disabled={false}
                    onSave={save}
                />,
            );
            fireEvent.change(screen.getByRole("spinbutton"), {
                target: { value },
            });
            expect(screen.getByRole("alert")).toHaveTextContent("whole dollar");
            expect(screen.getByRole("spinbutton")).toHaveAttribute(
                "aria-invalid",
                "true",
            );
            expect(
                screen.getByRole("button", { name: "Save limit" }),
            ).toBeDisabled();
            expect(save).not.toHaveBeenCalled();
        },
    );

    it("disables editing while saving or without permission", () => {
        const save = jest.fn();
        const { rerender } = render(
            <AutoTopUpMonthlyLimit
                auto={auto}
                disabled={false}
                onSave={save}
            />,
        );
        fireEvent.change(screen.getByRole("spinbutton"), {
            target: { value: "200" },
        });
        expect(
            screen.getByRole("button", { name: "Save limit" }),
        ).toBeEnabled();
        rerender(<AutoTopUpMonthlyLimit auto={auto} disabled onSave={save} />);
        expect(screen.getByRole("spinbutton")).toBeDisabled();
        const button = screen.getByRole("button", { name: "Save limit" });
        expect(button).toBeDisabled();
        fireEvent.click(button);
        expect(save).not.toHaveBeenCalled();
    });

    it("shows confirmed usage, pending capacity and the UTC reset when the next pack is blocked", () => {
        render(
            <AutoTopUpMonthlyLimit
                auto={{
                    ...auto,
                    monthlyReservedUsd: 20,
                    monthlyRemainingUsd: 30,
                    monthlyLimitReached: true,
                }}
                disabled={false}
                onSave={jest.fn()}
            />,
        );
        expect(screen.getByText(/This month:/)).toHaveTextContent(
            "$50 added automatically · $20 pending · limit $100",
        );
        expect(screen.getByRole("status")).toHaveTextContent("Jan 1 (UTC)");
        expect(screen.getByText(/Limit credits added/)).toHaveTextContent(
            "before the platform fee. Manual top-ups are separate.",
        );
    });

    it("does not offer an unenforced cap against an older billing deployment", () => {
        render(
            <AutoTopUpMonthlyLimit
                auto={{ ...auto, monthlyPurchasedUsd: undefined }}
                disabled={false}
                onSave={jest.fn()}
            />,
        );
        expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    });

    it("updates its saved value and usage from the server response", () => {
        const { rerender } = render(
            <AutoTopUpMonthlyLimit
                auto={auto}
                disabled={false}
                onSave={jest.fn()}
            />,
        );
        rerender(
            <AutoTopUpMonthlyLimit
                auto={{
                    ...auto,
                    monthlyLimitUsd: 200,
                    monthlyPurchasedUsd: 100,
                }}
                disabled={false}
                onSave={jest.fn()}
            />,
        );
        expect(screen.getByRole("spinbutton")).toHaveValue(200);
        expect(screen.getByText(/This month:/)).toHaveTextContent(
            "$100 added automatically",
        );
    });
});
