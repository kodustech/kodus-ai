/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { useUpdateEnvironmentSettings } from "@services/runtime/queries";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { WarmPool } from "./warm-pool";

jest.mock("@services/runtime/queries", () => ({
    useUpdateEnvironmentSettings: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

// Radix's radio group measures its items.
beforeAll(() => {
    global.ResizeObserver = class {
        observe = jest.fn();
        unobserve = jest.fn();
        disconnect = jest.fn();
    };
});

const mutate = jest.fn();
beforeEach(() => {
    mutate.mockReset();
    (useUpdateEnvironmentSettings as jest.Mock).mockReturnValue({
        mutate,
        isPending: false,
    });
});

const plan = { size: 1, setting: null, defaultSize: 1, maxSize: 3 };

describe("WarmPool", () => {
    it("shows what is kept and the plan's default, and saves a size up to the ceiling", () => {
        render(<WarmPool environmentId="env-1" pool={plan} canEdit />);
        expect(screen.getByText(/1 machine/)).toBeInTheDocument();
        expect(screen.getByText(/the plan's default/)).toBeInTheDocument();
        const input = screen.getByLabelText("Machines kept ready");
        expect(input).toHaveAttribute("placeholder", "Plan default (1)");
        expect(screen.getByText("up to 3 on your plan")).toBeInTheDocument();
        expect(
            screen.queryByText("Use the plan's default"),
        ).not.toBeInTheDocument();

        fireEvent.change(input, { target: { value: "2" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(mutate).toHaveBeenCalledWith(
            { environmentId: "env-1", poolSize: 2 },
            expect.anything(),
        );
    });

    it("refuses a size over the ceiling or not whole, and never sends it", () => {
        render(<WarmPool environmentId="env-1" pool={plan} canEdit />);
        const input = screen.getByLabelText("Machines kept ready");
        for (const bad of ["4", "1.5", "-1"]) {
            fireEvent.change(input, { target: { value: bad } });
            expect(screen.getByRole("alert")).toHaveTextContent(
                "A whole number from 0 to 3.",
            );
            expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
        }
        expect(mutate).not.toHaveBeenCalled();
    });

    it("goes back to the plan's default from a choice", () => {
        render(
            <WarmPool
                environmentId="env-1"
                pool={{ ...plan, size: 3, setting: 3 }}
                canEdit
            />,
        );
        expect(screen.getByText(/3 machines/)).toBeInTheDocument();
        fireEvent.click(
            screen.getByRole("button", { name: "Use the plan's default" }),
        );
        expect(mutate).toHaveBeenCalledWith(
            { environmentId: "env-1", poolSize: null },
            expect.anything(),
        );
    });

    it("says who may change it, and that a plan without a pool has none", () => {
        const { rerender } = render(
            <WarmPool environmentId="env-1" pool={plan} canEdit={false} />,
        );
        expect(screen.getByLabelText("Machines kept ready")).toBeDisabled();
        expect(
            screen.getByText(
                /Only the owner of the organization can change it/,
            ),
        ).toBeInTheDocument();
        rerender(
            <WarmPool
                environmentId="env-1"
                pool={{ size: 0, setting: null, defaultSize: 0, maxSize: 0 }}
                canEdit
            />,
        );
        expect(screen.getByText(/keeps no machines ready/)).toBeInTheDocument();
        expect(
            screen.queryByLabelText("Machines kept ready"),
        ).not.toBeInTheDocument();
    });

    it("saves working hours with a pull request warm-up and a budget, as one policy", () => {
        render(<WarmPool environmentId="env-1" pool={plan} canEdit />);
        fireEvent.click(screen.getByRole("radio", { name: /Working hours/ }));
        fireEvent.click(screen.getByRole("button", { name: "Fri" }));
        fireEvent.change(screen.getByLabelText("Ready from"), {
            target: { value: "09:00" },
        });
        fireEvent.change(screen.getByLabelText("Time zone"), {
            target: { value: "America/Sao_Paulo" },
        });
        fireEvent.click(
            screen.getByLabelText(/also warm up after pull request activity/),
        );
        fireEvent.change(
            screen.getByLabelText("Minutes after a pull request"),
            { target: { value: "45" } },
        );
        fireEvent.change(
            screen.getByLabelText("Monthly budget in US dollars"),
            { target: { value: "150" } },
        );
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(mutate).toHaveBeenCalledWith(
            {
                environmentId: "env-1",
                poolPolicy: {
                    schedule: {
                        timezone: "America/Sao_Paulo",
                        days: ["mon", "tue", "wed", "thu"],
                        start: "09:00",
                        end: "19:00",
                    },
                    onPullRequest: { idleMinutes: 45 },
                    monthlyBudgetUsd: 150,
                },
            },
            expect.anything(),
        );
    });

    it("refuses a schedule with no day and never sends it", () => {
        render(<WarmPool environmentId="env-1" pool={plan} canEdit />);
        fireEvent.click(screen.getByRole("radio", { name: /Working hours/ }));
        for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"])
            fireEvent.click(screen.getByRole("button", { name: d }));
        expect(screen.getByRole("alert")).toHaveTextContent(
            "Pick at least one day.",
        );
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });

    it("offers When as one radio group, on the saved choice, with each form under its option", () => {
        render(
            <WarmPool
                environmentId="env-1"
                pool={{
                    ...plan,
                    policy: { onPullRequest: { idleMinutes: 30 } },
                }}
                canEdit
            />,
        );
        const group = screen.getByRole("radiogroup", { name: "When" });
        expect(
            screen
                .getAllByRole("radio")
                .map((r) => r.getAttribute("aria-checked")),
        ).toEqual(["false", "false", "true"]);
        const afterPr = screen.getByRole("radio", {
            name: /After pull request activity/,
        });
        expect(group).toContainElement(afterPr);
        expect(
            screen.getByLabelText("Minutes after a pull request"),
        ).toHaveValue(30);
        expect(screen.queryByLabelText("Ready from")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("radio", { name: /All the time/ }));
        expect(
            screen.queryByLabelText("Minutes after a pull request"),
        ).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("radio", { name: /Working hours/ }));
        const days = screen.getByRole("group", { name: "Days" });
        // Nested right under its own option, before the next one.
        expect(
            screen
                .getByRole("radio", { name: /Working hours/ })
                .compareDocumentPosition(days) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            days.compareDocumentPosition(afterPr) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });

    it("moves the When choice with the arrow keys", async () => {
        render(<WarmPool environmentId="env-1" pool={plan} canEdit />);
        const always = screen.getByRole("radio", { name: /All the time/ });
        const hours = screen.getByRole("radio", { name: /Working hours/ });

        always.focus();
        fireEvent.keyDown(always, { key: "ArrowDown" });

        await waitFor(() => expect(hours).toHaveFocus());
        expect(hours).toHaveAttribute("aria-checked", "true");
        expect(screen.getByLabelText("Ready from")).toBeInTheDocument();
    });

    it("keeps the When choice and its form read-only without the right to edit", () => {
        render(
            <WarmPool
                environmentId="env-1"
                pool={{
                    ...plan,
                    policy: {
                        schedule: {
                            timezone: "UTC",
                            days: ["mon"],
                            start: "08:00",
                            end: "19:00",
                        },
                    },
                }}
                canEdit={false}
            />,
        );
        // Disabled for Radix too, not only through the fieldset: arrow keys
        // skip them and they render their disabled state.
        for (const radio of screen.getAllByRole("radio")) {
            expect(radio).toBeDisabled();
            expect(radio).toHaveAttribute("data-disabled");
        }
        expect(screen.getByLabelText("Ready from")).toBeDisabled();
        expect(screen.getByRole("button", { name: "Mon" })).toBeDisabled();
    });

    it("says what is ready now and why, what a ready machine saves and what it costs", () => {
        render(
            <WarmPool
                environmentId="env-1"
                pool={{
                    ...plan,
                    size: 2,
                    setting: 2,
                    policy: {
                        schedule: {
                            timezone: "UTC",
                            days: ["mon"],
                            start: "08:00",
                            end: "19:00",
                        },
                    },
                    now: { size: 0, reason: "outside_schedule" },
                    estimate: { hours: 48, usd: 38.71 },
                    spentUsd: 4.1,
                    usdPerMachineHour: 0.4032,
                }}
                canEdit
                bootP50Ms={95_000}
            />,
        );
        expect(screen.getByText(/ready now/)).toHaveTextContent(
            "No machines ready now (outside working hours).",
        );
        expect(screen.getByText(/skips the boot/)).toHaveTextContent(
            "about 1 min 35 s on this environment today",
        );
        expect(screen.getByText(/At most about/)).toHaveTextContent(
            "At most about $39 a month at list price (2 machines × 48 h × $0.40). This month so far: $4.10.",
        );
    });

    it("warns that nothing is kept until a setup boots", () => {
        render(
            <WarmPool
                environmentId="env-1"
                pool={plan}
                canEdit
                hasBake={false}
            />,
        );
        expect(
            screen.getByText(/nothing is kept ready until a setup boots/),
        ).toBeInTheDocument();
    });
});
