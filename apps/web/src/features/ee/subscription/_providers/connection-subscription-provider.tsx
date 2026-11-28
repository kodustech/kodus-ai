"use client";

import type { AwaitedReturnType } from "src/core/types";

import type {
    getUsersWithLicense,
    validateOrganizationLicense,
} from "../_services/billing/fetch";
import {
    SubscriptionProvider,
    useSubscriptionContext,
} from "./subscription-context";

/**
 * The subscription page speaks about the selected Git connection: its plan
 * and seats replace the workspace's, while the workspace-wide flags (a
 * connected key, the Kodus provider) stay as the app layout set them.
 */
export const ConnectionSubscriptionProvider = ({
    children,
    license,
    usersWithAssignedLicense,
}: React.PropsWithChildren & {
    license: AwaitedReturnType<typeof validateOrganizationLicense> | null;
    usersWithAssignedLicense: AwaitedReturnType<typeof getUsersWithLicense>;
}) => {
    const workspace = useSubscriptionContext();
    if (!license) return children;

    return (
        <SubscriptionProvider
            license={
                {
                    ...license,
                    byok: (workspace.license as { byok?: boolean }).byok,
                } as typeof license
            }
            usersWithAssignedLicense={usersWithAssignedLicense}
            usesKodusProvider={workspace.usesKodusProvider}>
            {children}
        </SubscriptionProvider>
    );
};
