/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { act, fireEvent, render, screen } from "@testing-library/react";

import type { BYOKConfig, BYOKModelConfig } from "../_types";
import { ModelRow } from "./model-row";

jest.mock("@services/organizationParameters/fetch", () => ({
    deleteBYOK: jest.fn(),
}));

const modalState: { props?: Record<string, any> } = {};
jest.mock("@components/ui/magic-modal", () => ({
    magicModal: {
        show: (factory: () => { props: Record<string, any> }) => {
            modalState.props = factory().props;
        },
        hide: jest.fn(),
    },
}));

describe("ModelRow", () => {
    it("names the model in the delete confirmation as the row shows it", async () => {
        const model = {
            id: "m1",
            model: "kimi-k2p7-code",
            credentialId: "c1",
        } as BYOKModelConfig;
        const config = {
            version: 2,
            credentials: [{ id: "c1", provider: "kodus" }],
            models: [model, { ...model, id: "m2", model: "gpt-5.4" }],
        } as unknown as BYOKConfig;
        render(
            <ModelRow
                model={model}
                label="Kimi K2.7 Code"
                config={config}
                catalog={{ name: "Kimi K2.7 Code (Kodus)" }}
                onDeleted={jest.fn()}
            />,
        );
        expect(screen.getByText("Kimi K2.7 Code (Kodus)")).toBeInTheDocument();
        await act(async () => {
            fireEvent.click(
                screen.getByRole("button", { name: "Remove model" }),
            );
        });
        expect(modalState.props?.title).toBe("Remove Kimi K2.7 Code (Kodus)?");
    });
});
