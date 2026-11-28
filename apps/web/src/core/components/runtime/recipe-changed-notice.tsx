import type { RuntimeRun } from "@services/runtime/contracts";

/** S-19: the recipe files a PR changes, or [] when it changes none (older Runs only carry the flag). */
export const recipeChangesOf = (
    run: Pick<RuntimeRun, "recipeChangedInPr" | "recipe">,
): { changed: boolean; files: string[] } => {
    const files = run.recipeChangedInPr ?? [];
    return {
        changed: files.length > 0 || !!run.recipe?.prChangesRecipe,
        files,
    };
};

/**
 * A PR that changes the recipe still runs with the base's (ADR-012): said
 * where the Run is read, so nobody takes the PR's recipe as tested.
 */
export const RecipeChangedNotice = ({
    run,
}: {
    run: Pick<RuntimeRun, "recipeChangedInPr" | "recipe">;
}) => {
    const { changed, files } = recipeChangesOf(run);
    if (!changed) return null;
    return (
        <p
            role="note"
            className="bg-card-lv2 text-text-secondary rounded-lg px-4 py-3 text-sm">
            <span className="text-text-primary font-medium">
                Setup file changed in this pull request.
            </span>{" "}
            This PR changes{" "}
            {files.length ? (
                files.map((f, i) => (
                    <span key={f}>
                        {i > 0 && ", "}
                        <code className="font-mono">{f}</code>
                    </span>
                ))
            ) : (
                <>the Runtime setup file</>
            )}
            . Kody boots every pull request with the setup file from the base
            branch, so the PR&apos;s copy was not tested.
        </p>
    );
};
