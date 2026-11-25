import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { ConnectionSubscriptionProvider } from "src/features/ee/subscription/_providers/connection-subscription-provider";
import { getBillingConnectionId } from "src/features/ee/subscription/_services/billing/billing-connection.server";
import {
    getUsersWithLicense,
    validateOrganizationLicense,
} from "src/features/ee/subscription/_services/billing/fetch";
import Layout from "src/features/ee/subscription/layout";

export default async function SubscriptionRouteLayout(
    props: React.ComponentProps<typeof Layout>,
) {
    const teamId = await getGlobalSelectedTeamId();
    // Set only while the workspace has several Git connections.
    const connectionId = await getBillingConnectionId(teamId);
    if (!connectionId) return <Layout {...props} />;

    const [license, usersWithAssignedLicense] = await Promise.all([
        validateOrganizationLicense({ teamId, connectionId }).catch(() => null),
        getUsersWithLicense({ teamId, connectionId }).catch(() => []),
    ]);

    return (
        <ConnectionSubscriptionProvider
            license={license}
            usersWithAssignedLicense={usersWithAssignedLicense}>
            <Layout {...props} />
        </ConnectionSubscriptionProvider>
    );
}
