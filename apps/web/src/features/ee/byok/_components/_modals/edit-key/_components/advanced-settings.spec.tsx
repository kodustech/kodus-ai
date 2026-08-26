/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";

import { ByokAdvancedSettings } from "./advanced-settings";

// The model reports it CAN reason (a thinking model like Kimi) so the toggle is
// enabled — this is exactly the case the "Off doesn't persist" bug lived in.
jest.mock("@services/organizationParameters/hooks", () => ({
    useModelCapabilities: () => ({
        data: {
            supportsReasoning: true,
            temperature: { kind: "adjustable" },
            reasoningOptions: [],
        },
    }),
}));

function Harness({ onValues }: { onValues: (v: any) => void }) {
    const form = useForm({
        defaultValues: {
            provider: "moonshot",
            model: "kimi-k2.6",
            // Starts at 'medium' — the catalog default the bug fell back to.
            reasoningEffort: "medium",
            reasoningConfigOverride: null,
        } as any,
    });
    onValues(() => form.getValues());
    return (
        <FormProvider {...form}>
            <ByokAdvancedSettings />
        </FormProvider>
    );
}

describe("ByokAdvancedSettings — reasoning toggle persistence (regression)", () => {
    it("selecting Off stores the explicit 'none' effort, NOT null (so it survives the save round-trip)", () => {
        let getValues: () => any = () => ({});
        render(<Harness onValues={(g) => (getValues = g)} />);

        // Sanity: starts at the catalog default.
        expect(getValues().reasoningEffort).toBe("medium");

        // Expand the collapsed "Advanced settings" section, then click "Off".
        const advanced = screen.queryByText("Advanced settings");
        if (advanced) fireEvent.click(advanced);
        fireEvent.click(screen.getByText("Off"));

        // The bug mapped Off → null, which buildConfig then dropped → the read
        // fell back to the catalog default (medium). It MUST be the explicit
        // 'none' so it persists and actually turns thinking off.
        expect(getValues().reasoningEffort).toBe("none");
        expect(getValues().reasoningEffort).not.toBeNull();
    });
});
