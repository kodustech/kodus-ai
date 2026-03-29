import { FEATURE_FLAGS } from "src/core/config/feature-flags";
import { isFeatureEnabled } from "src/core/utils/posthog-server-side";

import { SetupConnectingGitToolPage } from "./page.client";

export default async function ConnectingGitToolPage() {
    const githubEnterpriseServerPatEnabled = await isFeatureEnabled({
        feature: FEATURE_FLAGS.githubEnterpriseServerPat,
    }).catch(() => false);

    return (
        <SetupConnectingGitToolPage
            githubEnterpriseServerPatEnabled={
                githubEnterpriseServerPatEnabled
            }
        />
    );
}
