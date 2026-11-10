/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CreditsWalletStrip } from "./credits-wallet";

const update = jest.fn();
const remove = jest.fn();
const toast = jest.fn();
const credits = {
    known: true,
    balanceUsd: 100,
    neverFunded: false,
    exhausted: false,
    low: false,
    packsUsd: [20, 50, 100, 500],
    markupPct: 7,
    minPurchaseUsd: 15,
    maxPurchaseUsd: 5000,
    autoTopUp: {
        enabled: true,
        thresholdUsd: 5,
        amountUsd: 50,
        paymentMethod: "Visa",
        lastAt: null,
        lastError: null,
        monthlyLimitUsd: 100,
        monthlyPurchasedUsd: 0,
        monthlyReservedUsd: 50,
        monthlyRemainingUsd: 50,
        monthlyLimitReached: false,
        resetsAt: "2027-01-01T00:00:00.000Z",
    },
};
jest.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: jest.fn(), replace: jest.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock("../_hooks/use-kodus-credit-balance", () => ({
    useKodusCreditBalance: () => credits,
    kodusCreditBalanceKey: (team: string) => ["kodus-credits", "balance", team],
    KODUS_CREDITS_PATH: "/byok#kodus",
}));
jest.mock("src/core/providers/selected-team-context", () => ({
    useSelectedTeamId: () => ({ teamId: "team-1" }),
}));
jest.mock("@services/permissions/hooks", () => ({ usePermission: () => true }));
jest.mock("@services/kodus-credits/fetch", () => ({
    listKodusCreditCharges: jest.fn(async () => []),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({
    toast: (...args: unknown[]) => toast(...args),
}));
jest.mock("src/features/ee/subscription/_actions/credits", () => ({
    updateCreditAutoTopUpAction: (...args: unknown[]) => update(...args),
    removeCreditPaymentMethodAction: (...args: unknown[]) => remove(...args),
    listCreditLedgerAction: jest.fn(async () => []),
}));

describe("wallet pending-charge feedback", () => {
    beforeEach(() => {
        toast.mockClear();
        update.mockReset().mockResolvedValue({
            saveError:
                "Resolve the previous charge before changing its amount or card",
        });
        remove.mockReset().mockResolvedValue({
            saveError:
                "Resolve the previous charge before changing its amount or card",
        });
    });
    function wallet() {
        const client = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        client.setQueryData(["kodus-credits", "balance", "team-1"], {
            autoTopUp: credits.autoTopUp,
        });
        render(
            <QueryClientProvider client={client}>
                <CreditsWalletStrip />
            </QueryClientProvider>,
        );
        return client;
    }

    it("keeps the saved cap and warns instead of claiming a pending change succeeded", async () => {
        const client = wallet();
        fireEvent.change(
            screen.getByRole("spinbutton", {
                name: /monthly auto top-up limit/i,
            }),
            { target: { value: "200" } },
        );
        fireEvent.click(screen.getByRole("button", { name: "Save limit" }));
        await waitFor(() =>
            expect(toast).toHaveBeenCalledWith({
                variant: "warning",
                title: "Previous top-up pending",
                description:
                    "Resolve the previous charge before changing its amount or card",
            }),
        );
        expect(
            client.getQueryData(["kodus-credits", "balance", "team-1"]),
        ).toEqual({ autoTopUp: credits.autoTopUp });
        expect(toast.mock.calls.some(([t]) => t.variant === "success")).toBe(
            false,
        );
        client.clear();
    });

    it("does not announce card removal while the provider attempt is pending", async () => {
        const client = wallet();
        fireEvent.click(
            screen.getByRole("button", { name: /^Remove$/ }),
        );
        await waitFor(() =>
            expect(toast).toHaveBeenCalledWith({
                variant: "warning",
                title: "Previous top-up pending",
                description:
                    "Resolve the previous charge before changing its amount or card",
            }),
        );
        expect(toast.mock.calls.some(([t]) => t.title === "Card removed")).toBe(
            false,
        );
        client.clear();
    });
});
