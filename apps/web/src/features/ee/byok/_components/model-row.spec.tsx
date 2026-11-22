/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";

import type { BYOKConfig, BYOKModelConfig } from "../_types";
import { ModelRow } from "./model-row";

jest.mock("@services/organizationParameters/fetch", () => ({
    deleteBYOK: jest.fn(),
}));

const model = (id: string, name: string) =>
    ({ id, model: name, credentialId: "c1" }) as BYOKModelConfig;

describe("ModelRow", () => {
    it("names a pinned model and its alias by their ids, and keeps a label nobody else has", () => {
        const alias = model("a", "deepseek-ai/DeepSeek-V4.1-Flash");
        const pin = model("b", "deepseek-ai/DeepSeek-V4.1-Flash-1017");
        const kimi = model("c", "kimi-k2.6");
        const config = {
            credentials: [{ id: "c1", provider: "together" }],
            models: [alias, pin, kimi],
        } as unknown as BYOKConfig;

        render(
            <>
                <ModelRow model={alias} config={config} />
                <ModelRow model={pin} config={config} />
                <ModelRow model={kimi} config={config} />
            </>,
        );

        expect(
            screen.getByText(
                "DeepSeek V4.1 Flash (deepseek-ai/DeepSeek-V4.1-Flash)",
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "DeepSeek V4.1 Flash (deepseek-ai/DeepSeek-V4.1-Flash-1017)",
            ),
        ).toBeInTheDocument();
        expect(screen.getByText("Kimi K2.6")).toBeInTheDocument();
    });
});
