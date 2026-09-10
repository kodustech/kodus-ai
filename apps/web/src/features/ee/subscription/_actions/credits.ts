"use server";

import {
    createCreditCheckout,
    createCreditPaymentMethodCheckout,
    getCreditBalance,
    listCreditLedger,
    removeCreditPaymentMethod,
    updateCreditAutoTopUp,
} from "../_services/billing/fetch";

/** Balance + commercial parameters; null when billing has none / is down. */
export const getCreditBalanceAction = async ({
    teamId,
}: {
    teamId: string;
}) => {
    try {
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
        return await listCreditLedger({ teamId, limit, before });
    } catch (error) {
        console.error("Failed to load credit ledger:", error);
        return [];
    }
};

export const createCreditCheckoutAction = async ({
    teamId,
    creditUsd,
}: {
    teamId: string;
    creditUsd: number;
}) => {
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
    try {
        return await updateCreditAutoTopUp(params);
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Failed to save";
        console.error("Failed to update auto top-up:", error);
        // The billing service answers 409 NO_PAYMENT_METHOD when no card is
        // saved; surface it so the UI can route to the card step.
        throw new Error(
            /NO_PAYMENT_METHOD|409/.test(message)
                ? "NO_PAYMENT_METHOD"
                : "Failed to update auto top-up",
        );
    }
};

export const createCreditPaymentMethodCheckoutAction = async (params: {
    teamId: string;
}) => {
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
    try {
        return await removeCreditPaymentMethod(params);
    } catch (error) {
        console.error("Failed to remove the card:", error);
        throw new Error("Failed to remove the card");
    }
};
