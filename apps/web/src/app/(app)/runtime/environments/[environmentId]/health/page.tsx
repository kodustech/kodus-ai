import { decodeRouteParam } from "@services/runtime/route-params";

import { EnvironmentHealthPage } from "./_page-component";

export default async function RuntimeEnvironmentHealthPage({
    params,
}: {
    params: Promise<{ environmentId: string }>;
}) {
    const { environmentId } = await params;
    return (
        <EnvironmentHealthPage
            environmentId={decodeRouteParam(environmentId)}
        />
    );
}
