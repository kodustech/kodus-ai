/**
 * Session Manager - Secure Session Management
 * Prevents Session Hijacking attacks by implementing:
 * - Cryptographically secure UUIDs
 * - User-bound sessions
 * - Automatic expiration
 * - Periodic cleanup
 */

import { randomUUID } from 'node:crypto';

export interface Session {
    sessionId: string;
    userId?: string;
    tenantId: string;
    createdAt: number;
    lastActivity: number;
    expiresAt: number;
    metadata: Record<string, unknown>;
}

export interface ISessionManager {
    createSession(tenantId: string, userId?: string): string;
    validateSession(sessionId: string, userId?: string): boolean;
    destroySession(sessionId: string, userId?: string): void;
    getSessionMetadata(
        sessionId: string,
        userId?: string,
    ): Record<string, unknown> | null;
    updateSessionMetadata(
        sessionId: string,
        metadata: Record<string, unknown>,
        userId?: string,
    ): void;
    destroy(): void;
}

export class SessionManager implements ISessionManager {
    private static readonly sessionTimeoutMs = 30 * 60 * 1000; // 30 minutes
    private static readonly cleanupIntervalMs = 5 * 60 * 1000; // 5 minutes
    private sessions = new Map<string, Session>();
    private cleanupTimer?: NodeJS.Timeout;

    constructor() {
        // Start cleanup timer
        this.startCleanupTimer();
    }

    /**
     * Create a new secure session
     * Uses cryptographically secure random UUIDs
     */
    createSession(tenantId: string, userId?: string): string {
        const sessionId = randomUUID(); // Cryptographically secure
        const now = Date.now();

        const session: Session = {
            sessionId,
            userId,
            tenantId,
            createdAt: now,
            lastActivity: now,
            expiresAt: now + SessionManager.sessionTimeoutMs,
            metadata: {},
        };

        // Store with user binding: userId:sessionId format
        const key = userId
            ? `${userId}:${sessionId}`
            : `anonymous:${sessionId}`;
        this.sessions.set(key, session);

        return sessionId;
    }

    /**
     * Validate and refresh a session
     * Ensures session belongs to the correct user
     */
    validateSession(sessionId: string, userId?: string): boolean {
        // Find session by user binding
        const key = userId
            ? `${userId}:${sessionId}`
            : `anonymous:${sessionId}`;
        const session = this.sessions.get(key);

        if (!session) return false;

        // Check expiration
        if (Date.now() > session.expiresAt) {
            this.sessions.delete(key);
            return false;
        }

        // Update last activity and extend session
        session.lastActivity = Date.now();
        session.expiresAt =
            session.lastActivity + SessionManager.sessionTimeoutMs;

        return true;
    }

    /**
     * Destroy a session
     */
    destroySession(sessionId: string, userId?: string): void {
        const key = userId
            ? `${userId}:${sessionId}`
            : `anonymous:${sessionId}`;
        this.sessions.delete(key);
    }

    /**
     * Get session metadata
     */
    getSessionMetadata(
        sessionId: string,
        userId?: string,
    ): Record<string, unknown> | null {
        const key = userId
            ? `${userId}:${sessionId}`
            : `anonymous:${sessionId}`;
        const session = this.sessions.get(key);

        return session?.metadata || null;
    }

    /**
     * Update session metadata
     */
    updateSessionMetadata(
        sessionId: string,
        metadata: Record<string, unknown>,
        userId?: string,
    ): void {
        const key = userId
            ? `${userId}:${sessionId}`
            : `anonymous:${sessionId}`;
        const session = this.sessions.get(key);

        if (session) {
            session.metadata = { ...session.metadata, ...metadata };
        }
    }

    /**
     * Clean up expired sessions
     */
    private cleanupExpiredSessions(): void {
        const now = Date.now();
        for (const [key, session] of this.sessions) {
            if (now > session.expiresAt) {
                this.sessions.delete(key);
            }
        }
    }

    /**
     * Start periodic cleanup
     */
    private startCleanupTimer(): void {
        this.cleanupTimer = setInterval(() => {
            this.cleanupExpiredSessions();
        }, SessionManager.cleanupIntervalMs);
    }

    /**
     * Stop cleanup timer
     */
    destroy(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
        this.sessions.clear();
    }
}
