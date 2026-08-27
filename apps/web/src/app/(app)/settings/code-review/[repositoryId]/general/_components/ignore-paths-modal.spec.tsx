/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen } from "@testing-library/react";

import { IgnorePathsModal } from "./ignore-paths-modal";

// Radix's ScrollArea measures its viewport on mount; jsdom ships neither API.
beforeAll(() => {
    (globalThis as any).ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    (Element.prototype as any).scrollIntoView ??= () => {};
});

const PATHS = [
    "yarn.lock",
    "package-lock.json",
    "**/dist/**",
    "**/*.dist.js",
    "**/*.png",
];

const setup = (paths = PATHS) => {
    const onSave = jest.fn();
    const onCancel = jest.fn();

    render(
        <IgnorePathsModal
            initialPaths={paths}
            onSave={onSave}
            onCancel={onCancel}
        />,
    );

    return {
        onSave,
        onCancel,
        search: screen.getByPlaceholderText(/Search a pattern/),
        validator: screen.getByPlaceholderText("src/components/button.tsx"),
    };
};

/** Clicks Apply and returns the list handed to the form. */
const applied = (onSave: jest.Mock): string[] => {
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    return onSave.mock.calls[0][0];
};

describe("IgnorePathsModal", () => {
    it("filters the list down to the patterns matching what is typed", () => {
        const { search } = setup();

        expect(screen.getByText("5 patterns")).toBeInTheDocument();

        fireEvent.change(search, { target: { value: "dist" } });

        expect(screen.getByText("2 of 5 patterns")).toBeInTheDocument();
        expect(screen.getByText("**/dist/**")).toBeInTheDocument();
        expect(screen.getByText("**/*.dist.js")).toBeInTheDocument();
        expect(screen.queryByText("yarn.lock")).not.toBeInTheDocument();
    });

    it("adds the typed pattern on Enter and clears the filter", () => {
        const { search, onSave } = setup();

        fireEvent.change(search, { target: { value: "**/*.snap" } });
        fireEvent.keyDown(search, { key: "Enter" });

        expect(search).toHaveValue("");
        expect(screen.getByText("6 patterns")).toBeInTheDocument();
        expect(applied(onSave)).toEqual([...PATHS, "**/*.snap"]);
    });

    it("refuses to add a pattern that is already on the list", () => {
        const { search, onSave } = setup();

        fireEvent.change(search, { target: { value: "yarn.lock" } });
        fireEvent.keyDown(search, { key: "Enter" });

        expect(screen.getByText("1 of 5 patterns")).toBeInTheDocument();
        expect(
            screen.getByText(/Valid glob syntax — already on the list/),
        ).toBeInTheDocument();
        expect(applied(onSave)).toEqual(PATHS);
    });

    it("confirms the syntax of a well-formed pattern as it is typed", () => {
        const { search } = setup();

        fireEvent.change(search, { target: { value: "**/*.{ts,tsx}" } });

        expect(screen.getByText("Valid glob syntax.")).toBeInTheDocument();
    });

    it("reports the syntax error of a malformed pattern", () => {
        const { search } = setup();

        fireEvent.change(search, { target: { value: "**/[Bbuild/**" } });

        expect(screen.getByText(/Missing closing/)).toBeInTheDocument();
    });

    // `!src/**` would ignore every file OUTSIDE src/, silently dropping most
    // of the repo from review — the list is a flat OR with no re-inclusion.
    it("refuses a gitignore-style negation and explains what it would do", () => {
        const { search, onSave } = setup();

        fireEvent.change(search, { target: { value: "!src/**" } });

        expect(
            screen.getByText(/Negated patterns are not supported/),
        ).toBeInTheDocument();

        fireEvent.keyDown(search, { key: "Enter" });
        expect(applied(onSave)).toEqual(PATHS);
    });

    it("still accepts an extglob that merely starts with !", () => {
        const { search } = setup();

        fireEvent.change(search, { target: { value: "!(foo).js" } });

        expect(screen.getByText("Valid glob syntax.")).toBeInTheDocument();
    });

    it("refuses to add a malformed pattern, by Enter or by button", () => {
        const { search, onSave } = setup();

        fireEvent.change(search, { target: { value: "**/*.{ts,tsx" } });
        fireEvent.keyDown(search, { key: "Enter" });
        fireEvent.click(screen.getByText("Add"));

        expect(applied(onSave)).toEqual(PATHS);
    });

    // The tick means the syntax parses, nothing more. Promising that the
    // pattern is useful is what made the previous attempt misleading.
    it("calls a useless but well-formed pattern valid syntax, not valid", () => {
        const { search } = setup();

        fireEvent.change(search, { target: { value: "**/ / / / / 6 5 8" } });

        expect(screen.getByText("Valid glob syntax.")).toBeInTheDocument();
        expect(screen.queryByText("Valid pattern.")).not.toBeInTheDocument();
    });

    it("removes every filtered pattern at once, counting them on the button", () => {
        const { search, onSave } = setup();

        fireEvent.change(search, { target: { value: "dist" } });
        fireEvent.click(
            screen.getByRole("button", { name: "Remove filtered (2)" }),
        );

        expect(screen.getByText("3 patterns")).toBeInTheDocument();
        expect(applied(onSave)).toEqual([
            "yarn.lock",
            "package-lock.json",
            "**/*.png",
        ]);
    });

    it("offers no bulk removal while the search is empty", () => {
        setup();

        expect(
            screen.queryByRole("button", { name: /Remove filtered/ }),
        ).not.toBeInTheDocument();
    });

    it("removes a single pattern from its tag", () => {
        const { onSave } = setup();

        // Tags render as decorative (non-button) badges, so click the text.
        fireEvent.click(screen.getByText("yarn.lock"));

        expect(applied(onSave)).toEqual(PATHS.slice(1));
    });

    it("stays quiet until the tested file reaches four characters", () => {
        const { validator } = setup();

        fireEvent.change(validator, { target: { value: "a.p" } });

        expect(screen.getByText(/Type at least 4 characters/)).toBeVisible();
    });

    it("names the pattern that ignores the tested file", () => {
        const { validator } = setup();

        fireEvent.change(validator, { target: { value: "app/dist/main.js" } });

        // Scoped to the verdict line — the pattern also shows as a tag above.
        expect(screen.getByText(/Ignored by/)).toHaveTextContent(
            "Ignored by **/dist/**",
        );
    });

    it("clears a file that no pattern matches", () => {
        const { validator } = setup();

        fireEvent.change(validator, { target: { value: "src/button.tsx" } });

        expect(
            screen.getByText("This file will be reviewed."),
        ).toBeInTheDocument();
    });

    it("answers the file test against the draft, before it is applied", () => {
        const { search, validator } = setup();

        fireEvent.change(validator, { target: { value: "src/button.tsx" } });
        expect(
            screen.getByText("This file will be reviewed."),
        ).toBeInTheDocument();

        fireEvent.change(search, { target: { value: "**/*.tsx" } });
        fireEvent.keyDown(search, { key: "Enter" });

        expect(screen.getByText(/Ignored by/)).toBeInTheDocument();
    });

    it("throws the draft away on Cancel", () => {
        const { search, onCancel, onSave } = setup();

        fireEvent.change(search, { target: { value: "**/*.snap" } });
        fireEvent.keyDown(search, { key: "Enter" });
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(onCancel).toHaveBeenCalled();
        expect(onSave).not.toHaveBeenCalled();
    });

    // Apply commits to the form, not to the server. Labelling it "Save" next
    // to the page's "Save settings" already cost a user 43 removed patterns,
    // so both the wording and the note are load-bearing.
    it("does not present itself as persisting the change", () => {
        setup();

        expect(
            screen.queryByRole("button", { name: "Save" }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Apply" }),
        ).toBeInTheDocument();
        expect(screen.getByText(/Nothing is persisted/)).toHaveTextContent(
            "Save settings",
        );
    });
});
