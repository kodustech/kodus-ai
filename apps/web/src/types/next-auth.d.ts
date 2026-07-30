import type { UserRole } from "@enums";
import type { DefaultSession } from "next-auth";

// Type augmentation for next-auth v5. The Kodus JWT carries these claims and
// the auth callbacks stamp them onto the token — see src/core/config/auth.ts
// (getDataFromPayload + the jwt/session callbacks). The `session` callback sets
// `session.user = token`, so Session["user"] and JWT share the same shape.
//
// This only DECLARES what the runtime already populates; it changes no auth
// behaviour. Its point is to make RBAC and tenant reads type-checked instead of
// erroring — e.g. `session.user.role` (route guard / isOwner in permissions.ts
// and the app layout), `session.user.organizationId` (tenant scope) and
// `session.user.accessToken` (the bearer forwarded to the API).
interface KodusAuthFields {
    userId: string;
    email: string;
    /** Account status claim (e.g. "active", "pending"). */
    status: string;
    organizationId: string;
    role: UserRole;
    accessToken: string;
    refreshToken: string;
    /** Set by the jwt callback after a refresh, e.g. "expired-token". */
    reason?: string;
    iat?: number;
    exp?: number;
    jti?: string;
}

declare module "next-auth" {
    /** The object returned by the credentials/OAuth `authorize` step. */
    interface User {
        accessToken: string;
        refreshToken: string;
    }

    interface Session {
        user: KodusAuthFields & DefaultSession["user"];
    }
}

declare module "next-auth/jwt" {
    interface JWT extends KodusAuthFields {}
}
