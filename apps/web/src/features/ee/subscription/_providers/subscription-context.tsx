"use client";

import { createContext, useContext } from "react";
import type { AwaitedReturnType } from "src/core/types";
import { isSelfHosted } from "src/core/utils/self-hosted";

import type {
    getUsersWithLicense,
    validateOrganizationLicense,
} from "../_services/billing/fetch";

type License = {
    license: AwaitedReturnType<typeof validateOrganizationLicense>;
};
type UsersWithAssignedLicense = {
    usersWithAssignedLicense: AwaitedReturnType<typeof getUsersWithLicense>;
};

const SubscriptionContext = createContext<License & UsersWithAssignedLicense>({
    usersWithAssignedLicense: [],
    license: {
        valid: true,
        subscriptionStatus: "self-hosted",
    },
});

export const useSubscriptionContext = () => {
    const context = useContext(SubscriptionContext);
    return context;
};

export const SubscriptionProvider = ({
    children,
    license,
    usersWithAssignedLicense,
}: React.PropsWithChildren & {
    license: AwaitedReturnType<typeof validateOrganizationLicense>;
    usersWithAssignedLicense: AwaitedReturnType<typeof getUsersWithLicense>;
}) => {
    // Skip provider only for unlicensed self-hosted (uses context default)
    if (isSelfHosted && license.subscriptionStatus === "self-hosted") {
        return children;
    }

    return (
        <SubscriptionContext.Provider
            value={{ license, usersWithAssignedLicense }}>
            {children}
        </SubscriptionContext.Provider>
    );
};
