"use server";

import { canAccess } from "@services/permissions/fetch";
import { Action, ResourceType } from "@services/permissions/types";
import { captureCheckoutStarted } from "src/core/utils/gate-hit";

import {
    createCreditCheckout,
    createCreditPaymentMethodCheckout,
    getCreditBalance,
    listCreditLedger,
    removeCreditPaymentMethod,
    updateCreditAutoTopUp,
} from "../_services/billing/fetch";
import { BillingHttpError } from "../_services/billing/utils";

// New billing uses {code, error: readableMessage}; older error envelopes
// put the machine code in error. Neither format reaches the UI verbatim.
const isAutoTopUpPending = (error: unknown): boolean => {
    if (!(error instanceof BillingHttpError)) return false;
    const body = error.body as { code?: unknown; error?: unknown } | null;
    return (
        body?.code === "AUTO_TOP_UP_PENDING" ||
        body?.error === "AUTO_TOP_UP_PENDING"
    );
};
const autoTopUpPendingResult = {
    saveError: "Resolve the previous charge before changing its amount or card",
} as const;

/** Balance + commercial parameters; null when billing has none / is down. */
export const getCreditBalanceAction = async ({
    teamId,
}: {
    teamId: string;
}) => {
    try {
        await assertCanReadCredits();
        return await getCreditBalance({ teamId });
    } catch (error) {
        console.error("Failed to load credit balance:", error);
        return null;
    }
};

export const listCreditLedgerAction = async ({
    teamId,
    limit,
    before,
}: {
    teamId: string;
    limit?: number;
    before?: string;
}) => {
    try {
        await assertCanReadCredits();
        return await listCreditLedger({ teamId, limit, before });
    } catch (error) {
        console.error("Failed to load credit ledger:", error);
        return [];
    }
};

/**
 * Mutations on the org's money need the Billing update permission — checked
 * here on the server, not only where the buttons are hidden (a server action
 * can be called directly).
 */
/** Reading the org's balance/ledger needs the Billing read permission. */
// The API answers `/permissions/can-access` with a bare boolean (unwrapped
// from its envelope by authorizedFetch); tolerate an object shape too.
const isAllowed = (result: unknown): boolean =>
    result === true ||
    (typeof result === "object" &&
        result !== null &&
        (result as { canAccess?: unknown }).canAccess === true);

const permissionCheckFailed = (action: Action) => (error: unknown) => {
    console.error("[credits] permission check failed; denying", {
        resource: ResourceType.Billing,
        action,
        error: error instanceof Error ? error.message : String(error),
    });
    return false;
};

const assertCanReadCredits = async () => {
    const result = await canAccess(ResourceType.Billing, Action.Read).catch(
        permissionCheckFailed(Action.Read),
    );
    if (!isAllowed(result)) throw new Error("FORBIDDEN");
};

const assertCanManageCredits = async () => {
    const result = await canAccess(ResourceType.Billing, Action.Update).catch(
        permissionCheckFailed(Action.Update),
    );
    if (!isAllowed(result)) throw new Error("FORBIDDEN");
};

export const createCreditCheckoutAction = async ({
    teamId,
    creditUsd,
}: {
    teamId: string;
    creditUsd: number;
}) => {
    await assertCanManageCredits();
    try {
        const result = await createCreditCheckout({ teamId, creditUsd });
        if (!result?.url) throw new Error("no checkout url");

        captureCheckoutStarted({
            planId: "credits",
            kind: "credits",
            amountUsd: creditUsd,
        });

        return result;
    } catch (error) {
        console.error("Failed to create credit checkout:", error);
        throw new Error("Failed to create credit checkout");
    }
};

export const updateCreditAutoTopUpAction = async (params: {
    teamId: string;
    enabled: boolean;
    thresholdUsd?: number;
    amountUsd?: number;
    monthlyLimitUsd?: number | null;
}) => {
    await assertCanManageCredits();
    try {
        let result = await updateCreditAutoTopUp(params);
        // A successful mutation may return only the saved fields. Recover
        // the budget from its read endpoint before deciding this save failed.
        if (
            params.monthlyLimitUsd !== undefined &&
            result?.monthlyLimitUsd === params.monthlyLimitUsd &&
            result.monthlyPurchasedUsd === undefined
        ) {
            await assertCanReadCredits();
            const balance = await getCreditBalance({ teamId: params.teamId });
            if (
                !balance?.autoTopUp ||
                (balance.autoTopUp.monthlyLimitUsd ?? null) !==
                    (params.monthlyLimitUsd ?? null)
            ) {
                throw new Error(
                    "Monthly auto top-up limit could not be confirmed",
                );
            }
            result = {
                ...balance.autoTopUp,
                ...result,
                monthlyPurchasedUsd: balance.autoTopUp.monthlyPurchasedUsd,
            };
            if (
                typeof result.monthlyRemainingUsd === "number" &&
                typeof result.amountUsd === "number"
            ) {
                result.monthlyLimitReached =
                    result.monthlyRemainingUsd < result.amountUsd;
            }
        }
        // During a rolling deploy an older billing instance can ignore new
        // fields. Never claim a spending cap was saved without its response.
        if (
            params.monthlyLimitUsd !== undefined &&
            (result?.monthlyLimitUsd !== params.monthlyLimitUsd ||
                typeof result?.monthlyPurchasedUsd !== "number" ||
                !Number.isFinite(result.monthlyPurchasedUsd) ||
                result.monthlyPurchasedUsd < 0)
        ) {
            throw new Error("Monthly auto top-up limit was not saved");
        }
        return result;
    } catch (error) {
        if (isAutoTopUpPending(error)) return autoTopUpPendingResult;
        console.error("Failed to update auto top-up:", error);
        // Billing answers 409 NO_PAYMENT_METHOD when no card is saved and
        // 400 INVALID_* for a bad pair; surface the code so the UI can react.
        if (error instanceof BillingHttpError) {
            const code = (error.body as { error?: string } | null)?.error;
            if (code === "NO_PAYMENT_METHOD")
                throw new Error("NO_PAYMENT_METHOD");
            if (code) throw new Error(code);
        }
        throw new Error("Failed to update auto top-up");
    }
};

export const createCreditPaymentMethodCheckoutAction = async (params: {
    teamId: string;
}) => {
    await assertCanManageCredits();
    try {
        const result = await createCreditPaymentMethodCheckout(params);
        if (!result?.url) throw new Error("no checkout url");
        return result;
    } catch (error) {
        console.error("Failed to start the card setup:", error);
        throw new Error("Failed to start the card setup");
    }
};

export const removeCreditPaymentMethodAction = async (params: {
    teamId: string;
}) => {
    await assertCanManageCredits();
    try {
        return await removeCreditPaymentMethod(params);
    } catch (error) {
        if (isAutoTopUpPending(error)) return autoTopUpPendingResult;
        console.error("Failed to remove the card:", error);
        throw new Error("Failed to remove the card");
    }
};
