import { Suspense } from "react";

import GithubIntegrationClient from "./component/github-integration";

export default function GithubIntegrationPage() {
    return (
        <Suspense>
            <GithubIntegrationClient />
        </Suspense>
    );
}
