/**
 * Whether a provider's answer says a gateway refused to route a valid model
 * (an allowed-providers list, a region pin), rather than that the model or
 * the request is wrong. The backend classifier and the web banner both read
 * it, so a notification gets the same copy whenever it was created.
 *
 * Dependency-free on purpose: the isolated web build imports it.
 */
export function isRoutingRefusal(providerText?: string): boolean {
    const said = (providerText ?? '').toLowerCase();
    if (!said) return false;
    return (
        said.includes('allowed-providers') ||
        said.includes('allowed providers') ||
        (said.includes('no allowed') && said.includes('provider')) ||
        // Vercel AI Gateway with Region Pinning: "No provider for <model> can
        // serve any of the team's pinned inference regions (eu)".
        said.includes('pinned inference region')
    );
}
