/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { FilePatternsField } from "./file-patterns-field";

beforeAll(() => {
    global.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
});

it("caps approval/risk file lists at 100 and allows adding again after removal", () => {
    const changed = jest.fn();
    function Harness() {
        const [value, setValue] = useState(
            Array.from({ length: 99 }, (_, index) => `src/${index}/**`),
        );
        return (
            <FilePatternsField
                label="Included files"
                value={value}
                purpose="include"
                onChange={(next) => {
                    changed(next);
                    setValue(next);
                }}
            />
        );
    }
    render(<Harness />);
    fireEvent.click(
        screen.getByRole("button", { name: "Edit included files" }),
    );
    const input = screen.getByRole("textbox", {
        name: "Add or search file patterns",
    });
    fireEvent.change(input, { target: { value: "x".repeat(501) } });
    expect(screen.getByText("Use 500 characters or fewer.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "new/**" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(changed.mock.lastCall[0]).toHaveLength(100);
    expect(screen.getByRole("status")).toHaveTextContent(
        "Limit of 100 patterns reached",
    );
    fireEvent.change(input, { target: { value: "overflow/**" } });
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(changed).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove src/0/**" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "replacement/**" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(changed.mock.lastCall[0]).toHaveLength(100);
    expect(changed.mock.lastCall[0]).toContain("replacement/**");
    expect(changed.mock.lastCall[0]).not.toContain("overflow/**");
});
