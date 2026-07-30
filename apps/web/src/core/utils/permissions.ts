import { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";

import { hasPermission } from "./permission-map";
import { canAccessRoute, resourceRoutes, roleRoutes } from "./permissions.routes";

// Re-exported so existing importers keep working; the actual route logic lives
// in permissions.routes.ts (next/server-free, so it's unit-testable).
export { canAccessRoute, resourceRoutes, roleRoutes };

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
        // Carry the blocked path so /forbidden can say what was denied.
        const forbiddenUrl = new URL("/forbidden", req.url);
        forbiddenUrl.searchParams.set("from", pathname);
        return NextResponse.redirect(forbiddenUrl, { status: 302 });
    }

    // Allows access to the route
    return next;
}

export { hasPermission };
