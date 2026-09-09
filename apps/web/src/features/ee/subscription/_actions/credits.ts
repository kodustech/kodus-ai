"use server";

import {
    createCreditCheckout,
    getCreditBalance,
    listCreditLedger,
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
