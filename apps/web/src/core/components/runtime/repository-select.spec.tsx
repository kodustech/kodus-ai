/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen } from "@testing-library/react";

import { RepositorySelect } from "./repository-select";

beforeAll(() => {
    Element.prototype.scrollIntoView = jest.fn();
    if (!("ResizeObserver" in globalThis)) {
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
});

const repositories = {
    withEnvironment: [
        {
            id: "r1",
            name: "acme/shop",
            status: { label: "Ready", tone: "success" as const },
        },
        {
            id: "r2",
            name: "acme/billing",
            status: { label: "Setting up", tone: "info" as const },
        },
        { id: "r3", name: "acme/mobile" },
    ],
};

describe("RepositorySelect", () => {
    it("shows the chosen repository with its environment's state", () => {
        render(
            <RepositorySelect
                repositories={repositories}
                value="r1"
                onChange={jest.fn()}
            />,
        );
        const trigger = screen.getByRole("combobox", { name: "Repository" });
        expect(trigger).toHaveTextContent("acme/shop");
        expect(trigger).toHaveTextContent("Ready");
    });

    it("filters the repositories by what is typed and picks one", () => {
        const onChange = jest.fn();
        render(
            <RepositorySelect
                repositories={repositories}
                value="r1"
                onChange={onChange}
            />,
        );
        fireEvent.click(screen.getByRole("combobox", { name: "Repository" }));
        fireEvent.change(screen.getByPlaceholderText("Search repositories…"), {
            target: { value: "bill" },
        });
        expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(
            ["acme/billingSetting up"],
        );
        fireEvent.click(screen.getByRole("option", { name: /acme\/billing/ }));
        expect(onChange).toHaveBeenCalledWith("r2");
    });
});
