"use client";

import { getCookie, setCookie } from "cookies-next/client";

import {
    BILLING_CONNECTION_COOKIE,
    encodeBillingConnection,
    parseBillingConnection,
} from "./billing-connection";

export const readBillingConnectionId = (teamId: string) =>
    parseBillingConnection(getCookie(BILLING_CONNECTION_COOKIE), teamId);

export const selectBillingConnection = (teamId: string, connectionId: string) =>
    setCookie(
        BILLING_CONNECTION_COOKIE,
        encodeBillingConnection(teamId, connectionId),
        { maxAge: 60 * 60 * 24 * 365, path: "/" },
    );
