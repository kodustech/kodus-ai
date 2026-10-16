/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";

import { ByokModelSelect } from "./models";

// A live-listing provider so, unlocked, the component would try to render the
// picker (which we assert it does NOT when the model is in use in Routing).
// amazon_bedrock is included alongside it so the same suite can regression-test
// the Bedrock-specific credential gate without affecting apiKey-based providers.
const mockPreview = jest.fn();
jest.mock("@services/organizationParameters/hooks", () => ({
    useSuspenseGetLLMProviders: () => ({
        providers: [
            {
                id: "novita",
                autoListModels: true,
                listsModelsLive: true,
                requiresBaseUrl: false,
            },
            {
                id: "amazon_bedrock",
                autoListModels: true,
                listsModelsLive: true,
                requiresBaseUrl: false,
            },
            {
                // A custom endpoint: nothing to list before its base URL is
                // known, then the same live listing as any http provider.
                id: "openai_compatible",
                autoListModels: false,
                listsModelsLive: true,
                requiresBaseUrl: true,
            },
        ],
    }),
    useLLMProviderModelsPreview: (...args: unknown[]) => mockPreview(...args),
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

/** Renders the live picker directly (unlocked, no stored credential) with
 *  arbitrary form defaults — for exercising `ModelSelectLive`'s enable gate. */
function LivePickerHarness({
    defaultValues,
    credentialStored = false,
}: {
    defaultValues: Record<string, unknown>;
    credentialStored?: boolean;
}) {
    const form = useForm({ defaultValues: defaultValues as any });
    return (
        <FormProvider {...form}>
            <ByokModelSelect credentialStored={credentialStored} />
        </FormProvider>
    );
}

beforeEach(() => {
    mockPreview.mockReset();
    mockPreview.mockReturnValue({ data: [], isFetching: false, isError: false });
});

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

// Regression: commit d064c37c7 switched Bedrock from a static catalog to a live
// `/models` call (`listsModelsLive: true`), which routes it through the SAME
// gate every other live-listing provider uses — `hasKey` from `apiKey`. Bedrock
// never populates `apiKey` (it authenticates with awsBearerToken / IAM), so a
// fresh Bedrock connect got stuck on "Enter your API key to load models"
// forever, even though the backend already serves a curated fallback for a
// keyless Bedrock request. These pin the fix (a Bedrock-specific OR branch) and
// guard that apiKey-based providers are untouched by it.
describe("ByokModelSelect — Bedrock credential gate (regression: d064c37c7)", () => {
    it("Bedrock, nothing typed, no stored credential: stays on the key prompt (no false-positive enable)", () => {
        render(
            <LivePickerHarness
                defaultValues={{ provider: "amazon_bedrock", model: "" }}
            />,
        );
        expect(
            screen.getByText(/enter your api key to load models/i),
        ).toBeInTheDocument();
        expect(mockPreview).toHaveBeenCalledWith(
            expect.objectContaining({ enabled: false }),
        );
    });

    it("Bedrock, awsBearerToken typed: enables the picker and forwards the bearer token + region, not apiKey", () => {
        render(
            <LivePickerHarness
                defaultValues={{
                    provider: "amazon_bedrock",
                    model: "",
                    awsBearerToken: "ABSK-typed",
                    awsRegion: "us-east-1",
                }}
            />,
        );
        expect(
            screen.queryByText(/enter your api key to load models/i),
        ).not.toBeInTheDocument();
        expect(mockPreview).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: "amazon_bedrock",
                apiKey: undefined,
                awsBearerToken: "ABSK-typed",
                awsRegion: "us-east-1",
                enabled: true,
            }),
        );
    });

    it("Bedrock, IAM access key + secret typed (no bearer): enables the picker (curated fallback) but forwards NO bearer token — SigV4 can't drive a live call", () => {
        render(
            <LivePickerHarness
                defaultValues={{
                    provider: "amazon_bedrock",
                    model: "",
                    awsAccessKeyId: "AKIA-typed",
                    awsSecretAccessKey: "secret-typed",
                    awsRegion: "us-east-1",
                }}
            />,
        );
        expect(
            screen.queryByText(/enter your api key to load models/i),
        ).not.toBeInTheDocument();
        expect(mockPreview).toHaveBeenCalledWith(
            expect.objectContaining({
                awsBearerToken: undefined,
                enabled: true,
            }),
        );
    });

    it("Bedrock, only IAM access key typed (no secret yet): stays on the key prompt", () => {
        render(
            <LivePickerHarness
                defaultValues={{
                    provider: "amazon_bedrock",
                    model: "",
                    awsAccessKeyId: "AKIA-typed",
                }}
            />,
        );
        expect(
            screen.getByText(/enter your api key to load models/i),
        ).toBeInTheDocument();
    });

    it("apiKey-based provider (novita) is unaffected: apiKey alone still enables, aws* fields play no role", () => {
        render(
            <LivePickerHarness
                defaultValues={{
                    provider: "novita",
                    model: "",
                    apiKey: "sk-typed",
                }}
            />,
        );
        expect(
            screen.queryByText(/enter your api key to load models/i),
        ).not.toBeInTheDocument();
        expect(mockPreview).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: "novita",
                apiKey: "sk-typed",
                awsBearerToken: undefined,
                awsRegion: undefined,
                enabled: true,
            }),
        );
    });

    it("apiKey-based provider (novita) with no apiKey: stays on the key prompt even if aws* fields happen to be set", () => {
        // Defensive: aws* fields must never leak enable-power to a non-Bedrock
        // provider — `isBedrock` gates them off entirely.
        render(
            <LivePickerHarness
                defaultValues={{
                    provider: "novita",
                    model: "",
                    awsBearerToken: "ABSK-stray",
                }}
            />,
        );
        expect(
            screen.getByText(/enter your api key to load models/i),
        ).toBeInTheDocument();
        expect(mockPreview).toHaveBeenCalledWith(
            expect.objectContaining({ enabled: false }),
        );
    });
});

// Production 2026-09-25: editing a Fireworks model (openai_compatible) with a
// stored key and its base URL filled showed only "Type a model name" — the
// picker never asked the endpoint for its models, and there was no way back to
// a list.
describe("ByokModelSelect — custom endpoint (openai_compatible)", () => {
    const FIREWORKS = "https://api.fireworks.ai/inference/v1";

    it("stored key + base URL: lists the endpoint's models", () => {
        render(
            <LivePickerHarness
                credentialStored
                defaultValues={{
                    provider: "openai_compatible",
                    model: "",
                    baseURL: FIREWORKS,
                }}
            />,
        );
        expect(
            screen.queryByPlaceholderText(/type a model name/i),
        ).not.toBeInTheDocument();
        expect(mockPreview).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: "openai_compatible",
                baseURL: FIREWORKS,
                enabled: true,
            }),
        );
    });

    it("editing a key whose saved model the endpoint does not list: still shows that model", () => {
        // Endpoints list only part of what they serve; before the picker, a
        // compatible key always opened on the typed id. Showing "Select a
        // model" would read as the saved model being gone.
        mockPreview.mockReturnValue({
            data: [{ id: "accounts/fireworks/models/other", name: "Other" }],
            isFetching: false,
            isError: false,
        });
        render(
            <LivePickerHarness
                credentialStored
                defaultValues={{
                    provider: "openai_compatible",
                    model: "accounts/fireworks/models/deepseek-v4p1",
                    baseURL: FIREWORKS,
                }}
            />,
        );
        expect(screen.getByText("Deepseek V4p1")).toBeInTheDocument();
        expect(screen.queryByText(/select a model/i)).not.toBeInTheDocument();
    });

    it("typed key + base URL on a fresh connect: lists live", () => {
        render(
            <LivePickerHarness
                defaultValues={{
                    provider: "openai_compatible",
                    model: "",
                    apiKey: "fw-typed",
                    baseURL: FIREWORKS,
                }}
            />,
        );
        expect(mockPreview).toHaveBeenCalledWith(
            expect.objectContaining({
                apiKey: "fw-typed",
                baseURL: FIREWORKS,
                enabled: true,
            }),
        );
    });

    it("no base URL yet: asks for it, never calls the endpoint, keeps manual entry", () => {
        render(
            <LivePickerHarness
                credentialStored
                defaultValues={{ provider: "openai_compatible", model: "" }}
            />,
        );
        expect(
            screen.getByText(/enter the base url to load models/i),
        ).toBeInTheDocument();
        expect(mockPreview).toHaveBeenCalledWith(
            expect.objectContaining({ enabled: false }),
        );
        expect(
            screen.getByRole("button", { name: /type model manually/i }),
        ).toBeInTheDocument();
    });

    it("manual entry offers the way back to the list", () => {
        render(
            <LivePickerHarness
                credentialStored
                defaultValues={{ provider: "openai_compatible", model: "" }}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: /type model manually/i }),
        );

        expect(
            screen.getByPlaceholderText(/type a model name/i),
        ).toBeInTheDocument();
        fireEvent.click(
            screen.getByRole("button", { name: /select from list/i }),
        );
        expect(
            screen.queryByPlaceholderText(/type a model name/i),
        ).not.toBeInTheDocument();
    });
});
