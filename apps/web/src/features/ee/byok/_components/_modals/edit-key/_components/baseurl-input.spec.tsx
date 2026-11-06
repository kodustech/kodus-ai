/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";

import { ByokBaseURLInput } from "./baseurl-input";

jest.mock("@services/organizationParameters/hooks", () => ({
    useSuspenseGetLLMProviders: () => ({
        providers: [
            { id: "anthropic", requiresBaseUrl: false, acceptsBaseUrl: true },
            {
                id: "openai_compatible",
                requiresBaseUrl: true,
                acceptsBaseUrl: true,
            },
            {
                id: "google_vertex",
                requiresBaseUrl: false,
                acceptsBaseUrl: false,
            },
        ],
    }),
}));

function Harness({ provider }: { provider: string }) {
    const form = useForm({ defaultValues: { provider } as any });
    return (
        <FormProvider {...form}>
            <ByokBaseURLInput />
        </FormProvider>
    );
}

describe("ByokBaseURLInput", () => {
    it("offers an optional gateway base URL on a native provider that accepts one (#1828)", () => {
        render(<Harness provider="anthropic" />);
        expect(
            screen.getByLabelText(
                /Custom base URL \(proxy \/ gateway, optional\)/,
            ),
        ).toBeInTheDocument();
    });

    it("shows the required Base URL for a custom endpoint", () => {
        render(<Harness provider="openai_compatible" />);
        expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    });

    it("renders nothing for a provider that takes no base URL", () => {
        const { container } = render(<Harness provider="google_vertex" />);
        expect(container).toBeEmptyDOMElement();
    });
});
