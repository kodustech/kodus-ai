import { Action, ResourceType } from "@services/permissions/types";

import { BillingHttpError } from "../_services/billing/utils";
import {
    removeCreditPaymentMethodAction,
    updateCreditAutoTopUpAction,
} from "./credits";

const canAccessMock = jest.fn();
const updateMock = jest.fn();
const balanceMock = jest.fn();
const removeMock = jest.fn();
jest.mock("@services/permissions/fetch", () => ({
    canAccess: (...args: unknown[]) => canAccessMock(...args),
}));
jest.mock("src/core/utils/gate-hit", () => ({
    captureCheckoutStarted: jest.fn(),
}));
jest.mock("../_services/billing/fetch", () => ({
    updateCreditAutoTopUp: (...args: unknown[]) => updateMock(...args),
    getCreditBalance: (...args: unknown[]) => balanceMock(...args),
    removeCreditPaymentMethod: (...args: unknown[]) => removeMock(...args),
}));
jest.mock("../_services/billing/utils", () => ({
    BillingHttpError: class extends Error {
        constructor(
            public status: number,
            public body: unknown,
        ) {
            super("billing error");
        }
    },
}));

describe("monthly cap server action", () => {
    beforeEach(() => {
        canAccessMock.mockReset().mockResolvedValue(true);
        updateMock.mockReset();
        removeMock.mockReset();
        balanceMock.mockReset().mockResolvedValue(null);
    });

    it.each([200, 0, null])(
        "preserves limit %p and checks billing update permission",
        async (monthlyLimitUsd) => {
            const params = { teamId: "team-1", enabled: true, monthlyLimitUsd };
            updateMock.mockResolvedValue({
                enabled: true,
                monthlyLimitUsd,
                monthlyPurchasedUsd: 0,
            });
            expect(await updateCreditAutoTopUpAction(params)).toEqual({
                enabled: true,
                monthlyLimitUsd,
                monthlyPurchasedUsd: 0,
            });
            expect(canAccessMock).toHaveBeenCalledWith(
                ResourceType.Billing,
                Action.Update,
            );
            expect(updateMock).toHaveBeenCalledWith(params);
        },
    );

    it("checks authorization before verifying a zero-cap save", async () => {
        const params = { teamId: "team-1", enabled: true, monthlyLimitUsd: 0 };
        canAccessMock.mockResolvedValue(false);
        await expect(updateCreditAutoTopUpAction(params)).rejects.toThrow(
            "FORBIDDEN",
        );
        expect(updateMock).not.toHaveBeenCalled();
        expect(balanceMock).not.toHaveBeenCalled();

        canAccessMock.mockResolvedValue(true);
        updateMock.mockResolvedValue({ enabled: true, monthlyLimitUsd: 0 });
        balanceMock.mockResolvedValue({
            autoTopUp: {
                enabled: true,
                monthlyLimitUsd: 0,
                monthlyPurchasedUsd: 0,
            },
        });
        await expect(updateCreditAutoTopUpAction(params)).resolves.toEqual({
            enabled: true,
            monthlyLimitUsd: 0,
            monthlyPurchasedUsd: 0,
        });
        expect(updateMock).toHaveBeenCalledWith({
            teamId: "team-1",
            enabled: true,
            monthlyLimitUsd: 0,
        });
        expect(balanceMock).toHaveBeenCalledWith({ teamId: "team-1" });
    });

    it("does not claim a cap was saved when an older billing instance ignores it", async () => {
        updateMock.mockResolvedValue({ enabled: true });
        await expect(
            updateCreditAutoTopUpAction({
                teamId: "team-1",
                enabled: true,
                monthlyLimitUsd: 100,
            }),
        ).rejects.toThrow("Failed to update auto top-up");
    });

    it.each([undefined, NaN, -1, "0"])(
        "rejects an echoed cap with invalid enforcement data %p",
        async (monthlyPurchasedUsd) => {
            updateMock.mockResolvedValue({
                enabled: true,
                monthlyLimitUsd: 100,
                monthlyPurchasedUsd,
            });
            await expect(
                updateCreditAutoTopUpAction({
                    teamId: "team-1",
                    enabled: true,
                    monthlyLimitUsd: 100,
                }),
            ).rejects.toThrow("Failed to update auto top-up");
        },
    );

    it.each([100, 0, null])(
        "confirms a partial success by reading back the saved cap %p",
        async (monthlyLimitUsd) => {
            updateMock.mockResolvedValue({ enabled: true, monthlyLimitUsd });
            balanceMock.mockResolvedValue({
                autoTopUp: {
                    enabled: true,
                    monthlyLimitUsd,
                    monthlyPurchasedUsd: 20,
                },
            });
            await expect(
                updateCreditAutoTopUpAction({
                    teamId: "team-1",
                    enabled: true,
                    monthlyLimitUsd,
                }),
            ).resolves.toEqual({
                enabled: true,
                monthlyLimitUsd,
                monthlyPurchasedUsd: 20,
            });
            expect(balanceMock).toHaveBeenCalledWith({ teamId: "team-1" });
        },
    );

    it("does not confirm a partial response when read-back disagrees with the requested cap", async () => {
        updateMock.mockResolvedValue({ enabled: true, monthlyLimitUsd: 100 });
        balanceMock.mockResolvedValue({
            autoTopUp: {
                enabled: true,
                monthlyLimitUsd: null,
                monthlyPurchasedUsd: 0,
            },
        });
        await expect(
            updateCreditAutoTopUpAction({
                teamId: "team-1",
                enabled: true,
                monthlyLimitUsd: 100,
            }),
        ).rejects.toThrow("Failed to update auto top-up");
        expect(balanceMock).toHaveBeenCalledWith({ teamId: "team-1" });
    });

    it("requires Billing Read before using balance data to confirm a partial save", async () => {
        canAccessMock.mockImplementation((_resource, action) =>
            Promise.resolve(action === Action.Update),
        );
        updateMock.mockResolvedValue({ enabled: true, monthlyLimitUsd: 100 });
        await expect(
            updateCreditAutoTopUpAction({
                teamId: "team-1",
                enabled: true,
                monthlyLimitUsd: 100,
            }),
        ).rejects.toThrow("Failed to update auto top-up");
        expect(canAccessMock).toHaveBeenCalledWith(
            ResourceType.Billing,
            Action.Read,
        );
        expect(balanceMock).not.toHaveBeenCalled();
    });

    it("preserves mutation fields and recalculates the block state when read-back has older settings", async () => {
        updateMock.mockResolvedValue({
            enabled: true,
            amountUsd: 100,
            thresholdUsd: 10,
            monthlyLimitUsd: 100,
        });
        balanceMock.mockResolvedValue({
            autoTopUp: {
                enabled: false,
                amountUsd: 50,
                thresholdUsd: 5,
                monthlyLimitUsd: 100,
                monthlyPurchasedUsd: 20,
                monthlyRemainingUsd: 80,
                monthlyLimitReached: false,
            },
        });
        await expect(
            updateCreditAutoTopUpAction({
                teamId: "team-1",
                enabled: true,
                amountUsd: 100,
                thresholdUsd: 10,
                monthlyLimitUsd: 100,
            }),
        ).resolves.toEqual({
            enabled: true,
            amountUsd: 100,
            thresholdUsd: 10,
            monthlyLimitUsd: 100,
            monthlyPurchasedUsd: 20,
            monthlyRemainingUsd: 80,
            monthlyLimitReached: true,
        });
    });

    // Regression baseline: 6694fb0d3, before pending-charge handling was added.
    // Both actions threw there; these cases require a serializable warning.
    it.each([
        {
            operation: "settings",
            envelope: "current",
            body: {
                code: "AUTO_TOP_UP_PENDING",
                error: "Resolve the previous charge before changing its amount or card",
            },
        },
        {
            operation: "card",
            envelope: "current",
            body: {
                code: "AUTO_TOP_UP_PENDING",
                error: "Resolve the previous charge before changing its amount or card",
            },
        },
        {
            operation: "settings",
            envelope: "legacy",
            body: { error: "AUTO_TOP_UP_PENDING" },
        },
        {
            operation: "card",
            envelope: "legacy",
            body: { error: "AUTO_TOP_UP_PENDING" },
        },
    ])(
        "returns a readable pending-charge result for $operation ($envelope) without claiming success",
        async ({ operation, body }) => {
            const error = new BillingHttpError(409, body);
            updateMock.mockRejectedValue(error);
            removeMock.mockRejectedValue(error);
            const response =
                operation === "settings"
                    ? await updateCreditAutoTopUpAction({
                          teamId: "team-1",
                          enabled: true,
                          monthlyLimitUsd: 100,
                      })
                    : await removeCreditPaymentMethodAction({
                          teamId: "team-1",
                      });
            expect(response).toEqual({
                saveError:
                    "Resolve the previous charge before changing its amount or card",
            });
        },
    );

    it("confirms a cleared cap when balance omits the unset limit", async () => {
        updateMock.mockResolvedValue({ enabled: true, monthlyLimitUsd: null });
        balanceMock.mockResolvedValue({
            autoTopUp: { enabled: true, monthlyPurchasedUsd: 0 },
        });
        await expect(
            updateCreditAutoTopUpAction({
                teamId: "team-1",
                enabled: true,
                monthlyLimitUsd: null,
            }),
        ).resolves.toEqual({
            enabled: true,
            monthlyLimitUsd: null,
            monthlyPurchasedUsd: 0,
        });
    });

    it.each([null, { autoTopUp: null }])(
        "does not treat missing balance %p as confirmation of an unlimited cap",
        async (balance) => {
            updateMock.mockResolvedValue({
                enabled: true,
                monthlyLimitUsd: null,
            });
            balanceMock.mockResolvedValue(balance);
            await expect(
                updateCreditAutoTopUpAction({
                    teamId: "team-1",
                    enabled: true,
                    monthlyLimitUsd: null,
                }),
            ).rejects.toThrow("Failed to update auto top-up");
        },
    );

    it("surfaces validation failures instead of claiming the cap was saved", async () => {
        updateMock.mockRejectedValue(
            new BillingHttpError(400, { error: "INVALID_MONTHLY_LIMIT" }),
        );
        await expect(
            updateCreditAutoTopUpAction({
                teamId: "team-1",
                enabled: true,
                monthlyLimitUsd: -1,
            }),
        ).rejects.toThrow("INVALID_MONTHLY_LIMIT");
    });
});
