/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { useUpdateRuntimeOrgSettings } from "@services/runtime/queries";
import { fireEvent, render, screen } from "@testing-library/react";

import { ExercisedLinesThreshold } from "./exercised-lines-threshold";

jest.mock("@services/runtime/queries", () => ({
    useUpdateRuntimeOrgSettings: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

const mutate = jest.fn();
beforeEach(() => {
    mutate.mockReset();
    (useUpdateRuntimeOrgSettings as jest.Mock).mockReturnValue({
        mutate,
        isPending: false,
    });
});

const field = () =>
    screen.getByLabelText("Share of changed lines that must run");
const save = () => screen.getByRole("button", { name: "Save" });

describe("the org's exercised-lines threshold field", () => {
    it("shows the default when the org set none, and says what the number does", () => {
        render(
            <ExercisedLinesThreshold
                value={null}
                defaultPercent={50}
                canEdit
            />,
        );
        expect(field()).toHaveValue(null);
        expect(field()).toHaveAttribute("placeholder", "50 (the default)");
        expect(
            screen.getByText(
                "The default applies: a Run needs 50% of the changed lines to run.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                /marks it Partly tested instead of No regressions/,
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/0 never changes the verdict/),
        ).toBeInTheDocument();
    });

    it("saves a whole percent from 0 to 100", () => {
        render(
            <ExercisedLinesThreshold
                value={null}
                defaultPercent={50}
                canEdit
            />,
        );
        fireEvent.change(field(), { target: { value: "0" } });
        fireEvent.click(save());
        expect(mutate).toHaveBeenCalledWith(
            { exercisedLinesThresholdPercent: 0 },
            expect.anything(),
        );
    });

    it("refuses a number outside 0 to 100 and says why", () => {
        render(
            <ExercisedLinesThreshold
                value={null}
                defaultPercent={50}
                canEdit
            />,
        );
        fireEvent.change(field(), { target: { value: "150" } });
        expect(screen.getByRole("alert")).toHaveTextContent(
            "Enter a whole number from 0 to 100.",
        );
        expect(save()).toBeDisabled();
        fireEvent.submit(save().closest("form")!);
        expect(mutate).not.toHaveBeenCalled();
    });

    it("goes back to the default", () => {
        render(
            <ExercisedLinesThreshold value={30} defaultPercent={50} canEdit />,
        );
        expect(field()).toHaveValue(30);
        fireEvent.click(
            screen.getByRole("button", { name: "Use the default" }),
        );
        expect(mutate).toHaveBeenCalledWith(
            { exercisedLinesThresholdPercent: null },
            expect.anything(),
        );
    });

    it("offers no way back to the default while the org has none of its own", () => {
        render(
            <ExercisedLinesThreshold
                value={null}
                defaultPercent={50}
                canEdit
            />,
        );
        expect(
            screen.queryByRole("button", { name: "Use the default" }),
        ).not.toBeInTheDocument();
    });

    it("is read-only for members who cannot edit the organization's settings", () => {
        render(
            <ExercisedLinesThreshold
                value={30}
                defaultPercent={50}
                canEdit={false}
            />,
        );
        expect(field()).toBeDisabled();
        expect(save()).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Use the default" }),
        ).toBeDisabled();
        expect(
            screen.getByText("Only organization admins can change this."),
        ).toBeInTheDocument();
    });
});
