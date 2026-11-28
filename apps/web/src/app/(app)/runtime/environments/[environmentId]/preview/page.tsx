import { decodeRouteParam } from "@services/runtime/route-params";

import { EnvironmentPreviewPage } from "../../../runs/[runId]/preview/_page-component";

export default async function RuntimeEnvironmentPreviewPage({
    params,
}: {
    params: Promise<{ environmentId: string }>;
}) {
    const { environmentId } = await params;
    return <EnvironmentPreviewPage environmentId={decodeRouteParam(environmentId)} />;
}
