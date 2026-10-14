import { redirect } from "next/navigation";

/**
 * Retired: the severity threshold and "apply it to Kody Rules" moved to
 * "What to review", below the categories they filter. Kept as a redirect so
 * existing links and bookmarks land on the replacement.
 */
export default async function ReviewFiltersPage({
    params,
}: {
    params: Promise<{ repositoryId: string }>;
}) {
    const { repositoryId } = await params;
    redirect(`/settings/code-review/${repositoryId}/review-scope`);
}
