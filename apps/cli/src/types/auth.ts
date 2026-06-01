export interface AuthResponse {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    user: UserInfo;
}

export interface UserInfo {
    id: string;
    email: string;
    orgs: string[];
}

export interface StoredCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    user: UserInfo;
}
