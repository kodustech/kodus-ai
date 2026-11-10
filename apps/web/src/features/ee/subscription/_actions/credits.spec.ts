import { Action, ResourceType } from "@services/permissions/types";

import { BillingHttpError } from "../_services/billing/utils";
import { updateCreditAutoTopUpAction } from "./credits";

const canAccessMock = jest.fn();
const updateMock = jest.fn();
jest.mock("@services/permissions/fetch", () => ({
    canAccess: (...args: unknown[]) => canAccessMock(...args),
}));
jest.mock("src/core/utils/gate-hit", () => ({
    captureCheckoutStarted: jest.fn(),
}));
jest.mock("../_services/billing/fetch", () => ({
    updateCreditAutoTopUp: (...args: unknown[]) => updateMock(...args),
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

    it("prevents an unauthorized caller from changing the cap", async () => {
        canAccessMock.mockResolvedValue(false);
        await expect(
            updateCreditAutoTopUpAction({
                teamId: "team-1",
                enabled: true,
                monthlyLimitUsd: 200,
            }),
        ).rejects.toThrow("FORBIDDEN");
        expect(updateMock).not.toHaveBeenCalled();
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
