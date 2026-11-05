/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";

import { EnvConfigNotice } from "./env-config-notice";

/**
 * #1687: a self-hosted admin could not tell whether the env provider was the
 * one they set or one guessed from the model name, and a declaration that
 * could not run showed nothing at all on this page.
 */
describe("EnvConfigNotice", () => {
    it("says the provider came from API_LLM_PROVIDER when declared", () => {
        render(
            <EnvConfigNotice
                env={{
                    configured: true,
                    model: "my-alias",
                    providerId: "anthropic",
                    providerSource: "declared",
                    reasoningEffort: "low",
                }}
            />,
        );

        expect(screen.getByText(/set in/)).toBeVisible();
        expect(screen.queryByText(/guessed from the model name/)).toBeNull();
        expect(screen.getByText("low")).toBeVisible();
    });

    it("says the provider was guessed when nothing is declared", () => {
        render(
            <EnvConfigNotice
                env={{
                    configured: true,
                    model: "gpt-4o",
                    providerId: "openai_compatible",
                    providerSource: "inferred",
                }}
            />,
        );

        expect(screen.getByText(/guessed from the model name/)).toBeVisible();
        expect(screen.queryByText("Reasoning effort")).toBeNull();
    });

    it("lists each env warning", () => {
        const warning =
            "API_LLM_API_KEY and API_OPEN_AI_API_KEY are both set to different values; API_LLM_API_KEY is used.";
        render(
            <EnvConfigNotice
                env={{
                    configured: true,
                    model: "gpt-4o",
                    providerId: "openai",
                    providerSource: "declared",
                    warnings: [warning],
                }}
            />,
        );

        expect(screen.getByText(warning)).toBeVisible();
    });

    it("shows why a declared env model cannot run", () => {
        const reason =
            'API_LLM_PROVIDER="openrouter" is not supported. Use one of: openai, openai_compatible, anthropic, google_gemini, google_vertex.';
        render(
            <EnvConfigNotice
                env={{
                    configured: false,
                    model: "some-model",
                    providerSource: "declared",
                    invalidReason: reason,
                }}
            />,
        );

        expect(screen.getByText(/cannot run/)).toBeVisible();
        expect(screen.getByText(reason)).toBeVisible();
    });

    it("renders nothing when the env configures no model", () => {
        const { container } = render(
            <EnvConfigNotice env={{ configured: false }} />,
        );

        expect(container).toBeEmptyDOMElement();
    });
});
