import { decodeRouteParam } from "@services/runtime/route-params";
import { previewSideOf } from "@services/runtime/model/preview";

import { RunPreviewPage } from "./_page-component";

export default async function RuntimeRunPreviewPage({
    params,
    searchParams,
}: {
    params: Promise<{ runId: string }>;
    searchParams: Promise<{ side?: string | string[] }>;
}) {
    const { runId } = await params;
    const { side } = await searchParams;
    return (
        <RunPreviewPage
            runId={decodeRouteParam(runId)}
            side={previewSideOf(typeof side === "string" ? side : undefined)}
        />
    );
}
