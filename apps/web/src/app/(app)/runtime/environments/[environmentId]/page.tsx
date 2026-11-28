import { decodeRouteParam } from "@services/runtime/route-params";

import { EnvironmentDetailPage } from "./_page-component";

export default async function RuntimeEnvironmentPage({
    params,
}: {
    params: Promise<{ environmentId: string }>;
}) {
    const { environmentId } = await params;
    return (
        <EnvironmentDetailPage
            environmentId={decodeRouteParam(environmentId)}
        />
    );
}
