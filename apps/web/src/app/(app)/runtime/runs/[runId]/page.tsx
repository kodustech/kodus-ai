import { decodeRouteParam } from "@services/runtime/route-params";

import { RunDetailPage } from "./_page-component";

export default async function RuntimeRunPage({
    params,
}: {
    params: Promise<{ runId: string }>;
}) {
    const { runId } = await params;
    return <RunDetailPage runId={decodeRouteParam(runId)} />;
}
