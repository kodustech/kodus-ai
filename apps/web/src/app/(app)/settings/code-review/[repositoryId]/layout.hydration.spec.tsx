/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import {
    useController,
    useFormContext,
    useFormState,
    useWatch,
} from "react-hook-form";

import Layout from "./layout";

let mockConfig: any;
jest.mock("next/navigation", () => ({
    useParams: () => ({ repositoryId: "global" }),
}));
jest.mock("@services/parameters/hooks", () => ({
    useOptionalParameterQuery: () => ({ data: { configValue: "en-US" } }),
}));
jest.mock("@services/permissions/hooks", () => ({ usePermission: () => true }));
jest.mock("src/core/providers/selected-team-context", () => ({
    useSelectedTeamId: () => ({ teamId: "team" }),
}));
jest.mock("../../_hooks", () => ({
    useCodeReviewRouteParams: () => ({ repositoryId: "global" }),
}));
jest.mock("../../_components/context", () => ({
    useCodeReviewConfig: () => mockConfig,
    useDefaultCodeReviewConfig: () => ({}),
    useInitialTeamId: () => "team",
    useInitialParameter: () => null,
}));
function Editor() {
    const form = useFormContext();
    const { field } = useController({
        control: form.control,
        name: "riskCriteria.value",
    });
    const criteria = useWatch({
        control: form.control,
        name: "riskCriteria.value",
    });
    const { isDirty } = useFormState({ control: form.control });
    return (
        <>
            <output>{JSON.stringify(criteria)}</output>
            <span>{isDirty ? "dirty" : "clean"}</span>
            <button
                onClick={() =>
                    form.setValue("riskCriteria.value", [], {
                        shouldDirty: true,
                    })
                }>
                Delete criterion
            </button>
        </>
    );
}
it("preserves the last criterion deletion through the actual layout's same-scope refetch", async () => {
    const criterion = {
        id: "access",
        name: "Access control",
        instructions: "Check access",
        enabled: true,
    };
    mockConfig = { riskCriteria: { value: [criterion], level: "global" } };
    const view = render(
        <Layout>
            <Editor />
        </Layout>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete criterion" }));
    expect(screen.getByText("dirty")).toBeVisible();
    mockConfig = { riskCriteria: { value: [criterion], level: "global" } };
    await act(async () =>
        view.rerender(
            <Layout>
                <Editor />
            </Layout>,
        ),
    );
    await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("[]"),
    );
    expect(screen.getByText("dirty")).toBeVisible();
});
