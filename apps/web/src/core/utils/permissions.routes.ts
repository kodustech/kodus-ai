import { UserRole } from "@enums";
import { ResourceType } from "@services/permissions/types";
import { Role } from "@libs/identity/domain/permissions/enums/permissions.enum";
import { ROLE_POLICIES } from "@libs/identity/domain/permissions/policies/role-policies";

// Pure route-authorization logic, deliberately free of `next/server` so it can
// be imported directly by unit tests (permissions.route-coverage.spec.ts and
// permissions.routes.spec.ts). The `next/server`-dependent middleware glue
// lives in permissions.ts.

// Maps a resource to the URL prefixes that surface it. This is the only
// frontend-specific piece — what each role *can do* comes from ROLE_POLICIES
// (shared with the backend). Every page under app/(app) MUST be reachable
// from some entry here (pages open to every authenticated role go under the
// All base routes); permissions.route-coverage.spec.ts walks the filesystem
// and fails if a page is unmapped, so a new page can't silently 403 non-owners.
export const resourceRoutes: Partial<Record<ResourceType, string[]>> = {
    [ResourceType.All]: [
        "/user-waiting-for-approval/*",
        "/settings",
        "/forbidden/*",
        "/library/*",
        "/setup/*",
        "/auth/*",
        // Support iframe + CLI device-authorize flow: open to every
        // authenticated role, no dedicated backend resource.
        "/helpdesk/*",
        "/cli/*",
    ],
    [ResourceType.Billing]: ["/settings/subscription/*", "/choose-plan"],
    // `/review-suggestions` is the cockpit's suggestions explorer (a drill-down
    // from the Kodus Review tab), so it shares the Cockpit resource gate.
    [ResourceType.Cockpit]: ["/cockpit/*", "/review-suggestions"],
    [ResourceType.PullRequests]: ["/pull-requests/*"],
    [ResourceType.CliReview]: ["/cli-reviews/*"],
    [ResourceType.Issues]: ["/issues/*"],
    [ResourceType.CodeReviewSettings]: ["/settings/code-review/*"],
    [ResourceType.OrganizationSettings]: ["/organization/*"],
    [ResourceType.GitSettings]: ["/settings/git/*", "/settings/integrations/*"],
    [ResourceType.UserSettings]: ["/settings/subscription/*"],
    [ResourceType.PluginSettings]: ["/settings/plugins/*"],
    [ResourceType.Logs]: ["/user-logs/*"],
    [ResourceType.TokenUsage]: ["/token-usage/*"],
};

const baseRoutes = resourceRoutes[ResourceType.All] ?? [];

// Derive each non-owner role's accessible routes from the shared policy, so the
// middleware guard can never drift from the backend's permissions. Owner gets
// everything via the early return in canAccessRoute.
export const roleRoutes: Record<string, string[]> = Object.fromEntries(
    (Object.keys(ROLE_POLICIES) as Role[])
        .filter((role) => role !== Role.OWNER)
        .map((role) => {
            const resources = new Set(
                ROLE_POLICIES[role].map((rule) => rule.resource),
            );
            const routes = [
                ...baseRoutes,
                ...[...resources].flatMap(
                    (resource) => resourceRoutes[resource] ?? [],
                ),
            ];
            return [role, Array.from(new Set(routes))];
        }),
);

export const canAccessRoute = ({
    pathname,
    role,
}: {
    role: UserRole;
    pathname: string;
}): boolean => {
    if (role === UserRole.OWNER) return true;

    const rolePaths: string[] = roleRoutes[role] || [];

    const hasAccess = rolePaths.some((route) => {
        if (!route.includes(":")) {
            if (route.endsWith("/*")) {
                const baseRoute = route.replace("/*", "");
                // Match the base route itself or a true sub-path only — NOT a
                // sibling that merely shares the prefix string (e.g. `/cli/*`
                // must not grant `/cli-reviews`). A bare startsWith would be an
                // authorization bypass.
                return (
                    pathname === baseRoute ||
                    pathname.startsWith(baseRoute + "/")
                );
            }

            const matches = pathname === route;
            return matches;
        }

        const createRoutePattern = (route: string): string => {
            return route
                .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                .replace(/:teamId/g, "[\\w-]+")
                .replace(/:[a-zA-Z]+/g, "[\\w-]+");
        };

        const pattern = createRoutePattern(route);

        const regex = new RegExp(`^${pattern}(?:/.*)?$`);
        const matches = regex.test(pathname);
        return matches;
    });

    return hasAccess;
};
