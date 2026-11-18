import { Suspense } from "react";

import { RunsPage } from "./_page-component";

export default function RuntimeRunsPage() {
    return (
        <Suspense fallback={null}>
            <RunsPage />
        </Suspense>
    );
}
