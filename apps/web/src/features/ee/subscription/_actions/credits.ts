"use server";

import { canAccess } from "@services/permissions/fetch";
import { Action, ResourceType } from "@services/permissions/types";

import {
    createCreditCheckout,
    createCreditPaymentMethodCheckout,
    getCreditBalance,
    listCreditLedger,
    removeCreditPaymentMethod,
    updateCreditAutoTopUp,
} from "../_services/billing/fetch";
import { BillingHttpError } from "../_services/billing/utils";

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
}) => {
    await assertCanManageCredits();
    try {
        return await updateCreditAutoTopUp(params);
    } catch (error) {
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
        console.error("Failed to remove the card:", error);
        throw new Error("Failed to remove the card");
    }
};
