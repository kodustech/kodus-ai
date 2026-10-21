"use client";

import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { createManageBillingLinkAction } from "../_actions/create-manage-billing-link";

/** Opens the Stripe customer portal: invoices, card, plan, cancel. */
export const useManageBilling = () => {
    const { teamId } = useSelectedTeamId();

    return useAsyncAction(async () => {
        try {
            const { url } = await createManageBillingLinkAction({ teamId });
            window.location.href = url;
        } catch {
            toast({
                title: "Failed to create billing link",
                description: "Please try again later",
                variant: "warning",
            });
        }
    });
};
