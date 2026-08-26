/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";

import { ByokModelSelect } from "./models";

// A live-listing provider so, unlocked, the component would try to render the
// picker (which we assert it does NOT when the model is in use in Routing).
jest.mock("@services/organizationParameters/hooks", () => ({
    useSuspenseGetLLMProviders: () => ({
        providers: [
            {
                id: "novita",
                autoListModels: true,
                listsModelsLive: true,
                requiresBaseUrl: false,
            },
        ],
    }),
    useLLMProviderModelsPreview: () => ({
        data: [],
        isFetching: false,
        isError: false,
    }),
}));

function Harness({ lockedInUse }: { lockedInUse: boolean }) {
    const form = useForm({
        defaultValues: {
            provider: "novita",
            model: "deepseek/deepseek-v4-pro",
        } as any,
    });
    return (
        <FormProvider {...form}>
            <ByokModelSelect lockedInUse={lockedInUse} credentialStored />
        </FormProvider>
    );
}

describe("ByokModelSelect — lock when the model is in use in Routing", () => {
    it("locked: shows the current model read-only with the Routing hint, no search box", () => {
        render(<Harness lockedInUse />);

        // The friendly label is shown (read-only) — the locked field renders
        // `curated?.displayName ?? formatModelLabel(model)`, never the raw id, so a
        // deep-pathed id like "deepseek/deepseek-v4-pro" surfaces as its last
        // segment, title-cased. The hint points at Routing.
        expect(screen.getByText("Deepseek V4 Pro")).toBeInTheDocument();
        expect(screen.getByText(/in use in routing/i)).toBeInTheDocument();

        // The editable picker's search box must NOT render while locked.
        expect(
            screen.queryByPlaceholderText(/search models/i),
        ).not.toBeInTheDocument();
    });

    it("unlocked: renders the editable picker, not the lock hint", () => {
        render(<Harness lockedInUse={false} />);
        expect(screen.queryByText(/in use in routing/i)).not.toBeInTheDocument();
    });
});
