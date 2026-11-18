jest.mock("src/core/config/auth", () => ({ auth: jest.fn() }));
jest.mock("next/navigation", () => ({ redirect: jest.fn() }));

import { typedFetch, TypedFetchError } from "./fetch";

describe("typedFetch", () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
    });

    const respond = (body: BodyInit | null, init: ResponseInit) => {
        global.fetch = jest.fn(async () => new Response(body, init)) as typeof fetch;
    };

    it("resolves a 204 No Content answer as success, with no data", async () => {
        respond(null, { status: 204 });
        await expect(typedFetch<void>("http://api.test/thing", { method: "DELETE" })).resolves.toBeUndefined();
    });

    it("resolves a 200 with an empty body as success, with no data", async () => {
        respond("", { status: 200 });
        await expect(typedFetch<void>("http://api.test/thing")).resolves.toBeUndefined();
    });

    it("parses a JSON body", async () => {
        respond(JSON.stringify({ a: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
        await expect(typedFetch<{ a: number }>("http://api.test/thing")).resolves.toEqual({ a: 1 });
    });

    it("still throws a TypedFetchError on a non-ok status", async () => {
        respond(JSON.stringify({ message: "no" }), { status: 403 });
        await expect(typedFetch("http://api.test/thing")).rejects.toBeInstanceOf(TypedFetchError);
    });
});
