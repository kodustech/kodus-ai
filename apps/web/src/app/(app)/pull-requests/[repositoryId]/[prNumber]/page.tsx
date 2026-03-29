import type { Metadata } from "next";

import { ReviewPageClient } from "./_components/page.client";

export const metadata: Metadata = {
    title: "Code Review",
    openGraph: { title: "Code Review" },
};

export default async function ReviewPage({
    params,
}: {
    params: Promise<{ repositoryId: string; prNumber: string }>;
}) {
    const { repositoryId, prNumber } = await params;
    return (
        <ReviewPageClient
            repositoryId={repositoryId}
            prNumber={Number(prNumber)}
        />
    );
}
