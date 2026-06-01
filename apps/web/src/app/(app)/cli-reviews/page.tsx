import type { Metadata } from "next";

import { CliReviewsPageClient } from "./_components/page.client";

export const metadata: Metadata = {
    title: "CLI Reviews",
    openGraph: { title: "CLI Reviews" },
};

export default async function CliReviewsPage() {
    return <CliReviewsPageClient />;
}
