/**
 * GitHub App events that mean the installation can see a new repository: one
 * added to the installation (`installation_repositories`, always delivered to
 * apps) or one created under it (`repository`, delivered when the App is
 * subscribed to Repository events).
 */
export function isNewRepositoryEvent(
    event: string | undefined,
    payload: { action?: string } | undefined,
): boolean {
    return (
        (event === 'installation_repositories' &&
            payload?.action === 'added') ||
        (event === 'repository' && payload?.action === 'created')
    );
}
