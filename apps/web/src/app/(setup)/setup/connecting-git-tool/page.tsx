import { FEATURE_FLAGS } from "src/core/config/feature-flags";
import { getOrganizationReleaseTrack } from "@services/organizations/release-track";
import { isFeatureEnabled } from "src/core/feature-gate/resolver";

import { SetupConnectingGitToolPage } from "./page.client";

export default async function ConnectingGitToolPage() {
    const releaseTrack = await getOrganizationReleaseTrack();
    const githubEnterpriseServerPatEnabled = await isFeatureEnabled({
        feature: FEATURE_FLAGS.githubEnterpriseServerPat,
        releaseTrack,
    }).catch(() => false);

    return (
        <SetupConnectingGitToolPage
            githubEnterpriseServerPatEnabled={githubEnterpriseServerPatEnabled}
        />
    );
}
