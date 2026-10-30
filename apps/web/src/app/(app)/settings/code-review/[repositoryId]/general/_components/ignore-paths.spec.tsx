/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen } from "@testing-library/react";
import { FormProvider, useForm, useFormState } from "react-hook-form";

import { IgnorePaths } from "./ignore-paths";

beforeAll(() => {
    (globalThis as any).ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
});

// The override badge reaches for the code-review config context and the route.
// Neither is what this spec is about; stub them to the minimum.
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    usePathname: () => "/settings/code-review/global/general",
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ repositoryId: "global" }),
}));

jest.mock("src/app/(app)/settings/code-review/_components/override", () => ({
    OverrideIndicatorForm: () => null,
}));

const PATHS = ["yarn.lock", "package.json", ".env", "**/*.json", "**/dist/**"];

const Harness = ({ onState }: { onState: (s: unknown) => void }) => {
    const form = useForm({
        defaultValues: { ignorePaths: { value: PATHS } },
    });
    const { isDirty } = useFormState({ control: form.control });

    onState({ isDirty, values: form.getValues("ignorePaths.value") });

    return (
        <FormProvider {...form}>
            <IgnorePaths />
        </FormProvider>
    );
};

const setup = () => {
    let state: any = {};
    render(<Harness onState={(s) => (state = s)} />);
    return { get: () => state };
};

describe("IgnorePaths field", () => {
    it("shows the first four patterns plus a count of the rest", () => {
        setup();

        expect(screen.getByText("yarn.lock")).toBeInTheDocument();
        expect(screen.getByText("**/*.json")).toBeInTheDocument();
        expect(screen.getByText("+1 more")).toBeInTheDocument();
        expect(screen.queryByText("**/dist/**")).not.toBeInTheDocument();
    });

    it("marks the form dirty when a tag is removed inline", () => {
        const { get } = setup();

        expect(get().isDirty).toBe(false);
        fireEvent.click(screen.getByText("yarn.lock"));

        expect(get().isDirty).toBe(true);
        expect(get().values).toEqual(PATHS.slice(1));
    });

    // The regression that matters: Apply must leave the page dirty, so
    // "Save settings" (gated on isDirty) is clickable. When it isn't, the
    // count updates, the user believes it persisted, and a reload silently
    // restores the old list.
    it("marks the form dirty when the modal applies", () => {
        const { get } = setup();

        fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
        fireEvent.click(screen.getByText("**/dist/**"));
        fireEvent.click(screen.getByRole("button", { name: "Apply" }));

        expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
        expect(get().values).toEqual(PATHS.slice(0, 4));
        expect(get().isDirty).toBe(true);
    });

    it("leaves the form untouched when the modal is cancelled", () => {
        const { get } = setup();

        fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
        fireEvent.click(screen.getByText("**/dist/**"));
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(get().values).toEqual(PATHS);
        expect(get().isDirty).toBe(false);
    });

    it("reopens the modal on the applied list, with no stale draft", () => {
        setup();

        fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
        fireEvent.click(screen.getByText("**/dist/**"));
        fireEvent.click(screen.getByRole("button", { name: "Apply" }));
        fireEvent.click(screen.getByRole("button", { name: /Edit/ }));

        expect(screen.getByText("4 patterns")).toBeInTheDocument();
        expect(screen.queryByText("**/dist/**")).not.toBeInTheDocument();
    });

    it("reopens the modal on the original list after a cancel", () => {
        setup();

        fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
        fireEvent.click(screen.getByText("**/dist/**"));
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        fireEvent.click(screen.getByRole("button", { name: /Edit/ }));

        expect(screen.getByText("5 patterns")).toBeInTheDocument();
        expect(screen.getByText("**/dist/**")).toBeInTheDocument();
    });
});
