import { IUser } from '../interfaces/user.interface';

/**
 * Minimal projection of a request user — exactly the fields downstream
 * use-cases need for authorization checks and audit logs (uuid, email,
 * role, status, organization.uuid).
 *
 * Use this instead of passing `req.user` (full `IUser`) across module
 * boundaries: `IUser` carries the password hash, team memberships,
 * permissions matrix, etc., which application-layer use-cases must not
 * see.
 */
export type RequestUserContext = {
    uuid?: IUser['uuid'];
    email?: IUser['email'];
    role?: IUser['role'];
    status?: IUser['status'];
    organization?: { uuid?: string };
};

export function toRequestUserContext(
    user: Partial<IUser> | undefined | null,
): RequestUserContext | undefined {
    if (!user) {
        return undefined;
    }
    return {
        uuid: user.uuid,
        email: user.email,
        role: user.role,
        status: user.status,
        organization: user.organization?.uuid
            ? { uuid: user.organization.uuid }
            : undefined,
    };
}
