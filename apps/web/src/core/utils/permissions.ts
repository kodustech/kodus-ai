import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@enums";
import { ResourceType } from "@services/permissions/types";
import { Role } from "@libs/identity/domain/permissions/enums/permissions.enum";
import { ROLE_POLICIES } from "@libs/identity/domain/permissions/policies/role-policies";
import type { Session } from "next-auth";

import { hasPermission } from "./permission-map";

// Maps a resource to the URL prefixes that surface it. This is the only
// frontend-specific piece — what each role *can do* comes from ROLE_POLICIES
// (shared with the backend). Resources without a dedicated page (KodyRules,
// IssuesSettings, TokenUsage, CliReview, ...) simply have no entry here.
const resourceRoutes: Partial<Record<ResourceType, string[]>> = {
    [ResourceType.All]: [
        "/user-waiting-for-approval/*",
        "/settings",
        "/forbidden/*",
        "/library/*",
        "/setup/*",
        "/auth/*",
    ],
    [ResourceType.Billing]: ["/settings/subscription/*", "/choose-plan"],
    [ResourceType.Cockpit]: ["/cockpit/*"],
    [ResourceType.PullRequests]: ["/pull-requests/*"],
    [ResourceType.CliReview]: ["/cli-reviews/*"],
    [ResourceType.Issues]: ["/issues/*"],
    [ResourceType.CodeReviewSettings]: ["/settings/code-review/*"],
    [ResourceType.OrganizationSettings]: ["/organization/*"],
    [ResourceType.GitSettings]: ["/settings/git/*"],
    [ResourceType.UserSettings]: ["/settings/subscription/*"],
    [ResourceType.PluginSettings]: ["/settings/plugins/*"],
    [ResourceType.Logs]: ["/user-logs/*"],
};

const baseRoutes = resourceRoutes[ResourceType.All] ?? [];

// Derive each non-owner role's accessible routes from the shared policy, so the
// middleware guard can never drift from the backend's permissions. Owner gets
// everything via the early return in canAccessRoute.
const roleRoutes: Record<string, string[]> = Object.fromEntries(
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

const canAccessRoute = ({
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
                return pathname.startsWith(baseRoute);
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

export function handleAuthenticated(
    req: NextRequest,
    pathname: string,
    session: Session,
    next: NextResponse,
) {
    // Detects RSC (React Server Components) requests in multiple ways
    const isRSCRequest =
        req.nextUrl.searchParams.has("_rsc") ||
        req.headers.get("rsc") === "1" ||
        req.headers.get("next-router-prefetch") === "1" ||
        req.headers.get("next-router-state-tree") !== null;

    // Redirect root "/" to "/settings" (only if not RSC)
    if ((pathname === "/" || pathname === "") && !isRSCRequest) {
        return NextResponse.redirect(new URL("/settings", req.url), {
            status: 302,
        });
    }

    // If it is RSC request in root, it allows to pass
    if ((pathname === "/" || pathname === "") && isRSCRequest) return next;

    // If the user does not have permission, block access
    if (
        !canAccessRoute({
            pathname,
            role: session.user.role,
        })
    ) {
        return NextResponse.redirect(new URL("/forbidden", req.url), {
            status: 302,
        });
    }

    // Allows access to the route
    return next;
}

export { hasPermission };
