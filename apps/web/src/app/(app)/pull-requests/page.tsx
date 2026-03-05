import type { Metadata } from "next";

import { PullRequestsPageClient } from "./_components/page.client";

export const metadata: Metadata = {
    title: "Pull Requests",
    openGraph: { title: "Pull Requests" },
};

export default async function PullRequestsPage() {
    return <PullRequestsPageClient />;
}
