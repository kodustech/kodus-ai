/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { KodyRuleModalClient } from "./modal-client";

let mockRules: any[] = [];
jest.mock("@services/kodyRules/hooks", () => ({
    useSuspenseKodyRulesByRepositoryId: () => mockRules,
}));
jest.mock("@services/kodyRules", () => ({ KODY_RULES_PATHS: {} }));
jest.mock("@services/permissions/hooks", () => ({ usePermission: () => true }));
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: jest.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock(
    "@tanstack/react-query",
    () => ({
        useQueryClient: () => ({ invalidateQueries: jest.fn() }),
    }),
    { virtual: true },
);
jest.mock("../../../../_components/context", () => ({
    useFullCodeReviewConfig: () => ({ repositories: [] }),
}));
// Exercise the same mount-only defaultValues contract as the real modal,
// without importing unrelated rule fields and API dependencies.
jest.mock("../../../_components/modal", () => ({
    KodyRuleAddOrUpdateItemModal: ({ rule }: any) => {
        const { useForm } = require("react-hook-form");
        const { register } = useForm({ defaultValues: { rule: rule.rule } });
        return <input aria-label="Instructions" {...register("rule")} />;
    },
}));

describe("KodyRuleModalClient form initialization", () => {
    it("uses resolved scope data on the first form render", () => {
        mockRules = [{ uuid: "one", rule: "Hydrated @file:src/a.ts" }];
        render(
            <KodyRuleModalClient
                rule={{ uuid: "one", rule: "Stale" } as any}
                repositoryId="repo"
            />,
        );
        expect(
            (screen.getByLabelText("Instructions") as HTMLInputElement).value,
        ).toBe("Hydrated @file:src/a.ts");
    });

    it("preserves edits on refetch and resets when selecting another memory", () => {
        mockRules = [{ uuid: "one", rule: "Initial" }];
        const { rerender } = render(
            <KodyRuleModalClient rule={mockRules[0]} repositoryId="repo" />,
        );
        fireEvent.change(screen.getByLabelText("Instructions"), {
            target: { value: "User draft" },
        });
        mockRules = [{ uuid: "one", rule: "Refetched" }];
        rerender(
            <KodyRuleModalClient rule={mockRules[0]} repositoryId="repo" />,
        );
        expect(
            (screen.getByLabelText("Instructions") as HTMLInputElement).value,
        ).toBe("User draft");
        mockRules = [{ uuid: "two", rule: "Second memory" }];
        rerender(
            <KodyRuleModalClient rule={mockRules[0]} repositoryId="repo" />,
        );
        expect(
            (screen.getByLabelText("Instructions") as HTMLInputElement).value,
        ).toBe("Second memory");
    });
});
