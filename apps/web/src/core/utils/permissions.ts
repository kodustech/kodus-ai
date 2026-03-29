import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@enums";
import { ResourceType } from "@services/permissions/types";
import type { Session } from "next-auth";
import { hasPermission } from "./permission-map";

const resourceRoutes = {
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
    [ResourceType.Issues]: ["/issues/*"],
    [ResourceType.CodeReviewSettings]: ["/settings/code-review/*"],
    [ResourceType.OrganizationSettings]: ["/organization/*"],
    [ResourceType.GitSettings]: ["/settings/git/*"],
    [ResourceType.UserSettings]: ["/settings/subscription/*"],
    [ResourceType.PluginSettings]: ["/settings/plugins/*"],
    [ResourceType.Logs]: ["/user-logs/*"],
};

const roleRoutes = {
    [UserRole.REPO_ADMIN]: [
        ...resourceRoutes[ResourceType.All],
        ...resourceRoutes[ResourceType.PullRequests],
        ...resourceRoutes[ResourceType.Issues],
        ...resourceRoutes[ResourceType.Cockpit],
        ...resourceRoutes[ResourceType.CodeReviewSettings],
        ...resourceRoutes[ResourceType.GitSettings],
        ...resourceRoutes[ResourceType.PluginSettings],
        ...resourceRoutes[ResourceType.Logs],
    ],
    [UserRole.BILLING_MANAGER]: [
        ...resourceRoutes[ResourceType.All],
        ...resourceRoutes[ResourceType.Billing],
        ...resourceRoutes[ResourceType.CodeReviewSettings],
        ...resourceRoutes[ResourceType.GitSettings],
        ...resourceRoutes[ResourceType.PluginSettings],
        ...resourceRoutes[ResourceType.Logs],
    ],
    [UserRole.CONTRIBUTOR]: [
        ...resourceRoutes[ResourceType.All],
        ...resourceRoutes[ResourceType.CodeReviewSettings],
        ...resourceRoutes[ResourceType.Issues],
    ],
};

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
