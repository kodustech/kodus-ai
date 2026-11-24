"use client";

import { deleteCookie, getCookie, setCookie } from "cookies-next/client";

/**
 * "Add a connection" survives provider redirects (OAuth, the GitHub App
 * install) in a short-lived cookie, so the connect call at the end of any
 * provider flow creates a new Git connection instead of rewriting the
 * workspace's existing one.
 */
const COOKIE = "git-connection-intent";
const MAX_AGE_SECONDS = 30 * 60;

export type ConnectionIntent = { newConnection: true; name?: string };

export const startNewConnectionIntent = (name?: string) => {
    const intent: ConnectionIntent = {
        newConnection: true,
        ...(name?.trim() ? { name: name.trim() } : {}),
    };
    setCookie(COOKIE, JSON.stringify(intent), { maxAge: MAX_AGE_SECONDS });
};

export const clearConnectionIntent = () => deleteCookie(COOKIE);

export const readConnectionIntent = (): ConnectionIntent | undefined => {
    const raw = getCookie(COOKIE);
    if (typeof raw !== "string" || !raw) return undefined;
    try {
        const parsed = JSON.parse(raw) as Partial<ConnectionIntent>;
        return parsed?.newConnection === true
            ? {
                  newConnection: true,
                  ...(typeof parsed.name === "string"
                      ? { name: parsed.name }
                      : {}),
              }
            : undefined;
    } catch {
        return undefined;
    }
};
