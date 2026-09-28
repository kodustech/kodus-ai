import { redirect } from "next/navigation";

/**
 * Retired: the category toggles moved to "What to review", next to the
 * per-category instructions and the severity threshold. Kept as a redirect
 * so existing links and bookmarks land on the replacement.
 */
export default async function ReviewCategoriesPage({
    params,
}: {
    params: Promise<{ repositoryId: string }>;
}) {
    const { repositoryId } = await params;
    redirect(`/settings/code-review/${repositoryId}/review-scope`);
}
