import {
    billingSignaturePayload as backendPayload,
    BILLING_SIGNATURE_HEADER,
    BILLING_TIMESTAMP_HEADER,
    billingSignatureHeaders,
    billingSignaturePayload,
} from "@libs/common/utils/billing-signature";

import {
    canonicalBillingQuery,
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
    billingSignaturePayload as webPayload,
} from "./signature";

/**
 * The web signs its server-side billing calls with its own copy of the payload
 * builder (it cannot import from `libs` at runtime — that is also why
 * model-label has a parity spec). If the two drift, every credit call from the
 * web answers 401 and nothing in either repo's tests would notice.
 *
 * `libs/common/utils/billing-signature.ts` is the reference; the backend copy
 * is itself pinned to the verifier in kodus-service-billing by that repo's
 * serviceToken.spec.ts.
 */
describe("billing signature parity (web ↔ backend)", () => {
    const TS = "1789000000000";

    const cases: Array<{
        name: string;
        method: string;
        /** Path as the web passes it: relative, query included. */
        webPath: string;
    }> = [
        {
            name: "balance read, org only",
            method: "GET",
            webPath: "credits/balance?organizationId=org-1",
        },
        {
            name: "balance read, org + team",
            method: "GET",
            webPath: "credits/balance?organizationId=org-1&teamId=team-9",
        },
        {
            name: "params out of order",
            method: "GET",
            webPath: "credits/balance?teamId=team-9&organizationId=org-1",
        },
        {
            name: "ledger with paging",
            method: "GET",
            webPath:
                "credits/ledger?organizationId=org-1&limit=50&before=2026-09-10T12%3A00%3A00.000Z",
        },
        {
            name: "leading slash",
            method: "GET",
            webPath: "/credits/balance?organizationId=org-1",
        },
        {
            name: "no query at all",
            method: "POST",
            webPath: "credits/debit",
        },
        {
            name: "delete with a query",
            method: "DELETE",
            webPath: "credits/payment-method?organizationId=org-1",
        },
        {
            // A literal "?" inside a value: splitting on every "?" instead of
            // the first would sign a truncated query on one side only.
            name: "a query value containing a literal ?",
            method: "GET",
            webPath:
                "credits/balance?organizationId=org-1&returnTo=/byok?credits=success",
        },
        {
            name: "an empty query value",
            method: "GET",
            webPath: "credits/balance?organizationId=org-1&teamId=",
        },
    ];

    it.each(cases)(
        "builds the same payload as the backend: $name",
        ({ method, webPath }) => {
            const body =
                method === "GET" || method === "DELETE"
                    ? ""
                    : JSON.stringify({ organizationId: "org-1", entries: [] });
            const q = webPath.indexOf("?");
            const path = q === -1 ? webPath : webPath.slice(0, q);
            const query = q === -1 ? "" : webPath.slice(q + 1);
            expect(webPayload(method, webPath, TS, body)).toBe(
                backendPayload({
                    method,
                    path: `/api/billing/${path.replace(/^\//, "")}`,
                    query,
                    timestamp: TS,
                    rawBody: body,
                }),
            );
        },
    );

    it("agrees on the header names", () => {
        expect(SIGNATURE_HEADER).toBe(BILLING_SIGNATURE_HEADER);
        expect(TIMESTAMP_HEADER).toBe(BILLING_TIMESTAMP_HEADER);
    });

    it("canonicalizes the query the same way", () => {
        for (const query of [
            "organizationId=o&teamId=t",
            "teamId=t&organizationId=o",
            "",
            "limit=50&organizationId=o&before=2026-09-10T12%3A00%3A00.000Z",
        ]) {
            expect(canonicalBillingQuery(query)).toBe(
                backendPayload({
                    method: "GET",
                    path: "/x",
                    query,
                    timestamp: "0",
                }).split("\n")[2],
            );
        }
    });

    it("produces a usable header pair on the backend side", () => {
        const headers = billingSignatureHeaders({
            secret: "s",
            method: "GET",
            path: "/api/billing/credits/balance",
            query: { organizationId: "org-1", teamId: undefined },
            now: Number(TS),
        });
        expect(headers[BILLING_TIMESTAMP_HEADER]).toBe(TS);
        expect(headers[BILLING_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
        // An undefined param must not become the string "undefined".
        expect(
            billingSignaturePayload({
                method: "GET",
                path: "/api/billing/credits/balance",
                query: { organizationId: "org-1", teamId: undefined },
                timestamp: TS,
            }).split("\n")[2],
        ).toBe("organizationId=org-1");
    });

    it("returns no headers when no secret is configured (fails closed)", () => {
        expect(
            billingSignatureHeaders({
                secret: "",
                method: "GET",
                path: "/api/billing/credits/balance",
            }),
        ).toEqual({});
    });
});
