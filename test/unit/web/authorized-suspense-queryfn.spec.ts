import { buildAuthorizedSuspenseQueryFn } from "../../../apps/web/src/core/utils/authorized-fetch";

/**
 * Covers the fetch/parse/fallback semantics shared by useSuspenseFetch and
 * useSuspenseFetchMany (the parallel variant added to kill the page's
 * suspense waterfall). The parallel wiring itself is React Query's
 * useSuspenseQueries; this pins the part we authored.
 */
describe("buildAuthorizedSuspenseQueryFn", () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
        jest.restoreAllMocks();
    });

    const mockResponse = (body: string) =>
        ({ text: async () => body }) as unknown as Response;

    const run = <T>(opts: {
        token?: string | null;
        fallback?: T;
        fetchImpl: () => Promise<Response>;
    }) => {
        global.fetch = jest.fn(opts.fetchImpl) as any;
        return buildAuthorizedSuspenseQueryFn<T>(
            "/api/x",
            { params: { a: 1 } },
            opts.token ?? "tok",
            opts.fallback,
        )({ signal: undefined as any });
    };

    it("returns data on a 200 envelope", async () => {
        await expect(
            run({
                fetchImpl: async () =>
                    mockResponse(
                        JSON.stringify({ statusCode: 200, data: { ok: 1 } }),
                    ),
            }),
        ).resolves.toEqual({ ok: 1 });
    });

    it("sends the bearer token", async () => {
        const fetchImpl = jest
            .fn()
            .mockResolvedValue(
                mockResponse(JSON.stringify({ statusCode: 200, data: [] })),
            );
        global.fetch = fetchImpl as any;
        await buildAuthorizedSuspenseQueryFn(
            "/api/x",
            undefined,
            "my-token",
            undefined,
        )({ signal: undefined as any });
        expect(fetchImpl).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                headers: { Authorization: "Bearer my-token" },
            }),
        );
    });

    it("uses fallbackData on 404 when provided", async () => {
        await expect(
            run({
                fallback: { fallback: true },
                fetchImpl: async () =>
                    mockResponse(JSON.stringify({ statusCode: 404 })),
            }),
        ).resolves.toEqual({ fallback: true });
    });

    it("throws on 404 without fallback", async () => {
        await expect(
            run({
                fetchImpl: async () =>
                    mockResponse(JSON.stringify({ statusCode: 404 })),
            }),
        ).rejects.toThrow(/not found/i);
    });

    it("throws on non-2xx status (e.g. 500)", async () => {
        await expect(
            run({
                fetchImpl: async () =>
                    mockResponse(JSON.stringify({ statusCode: 500 })),
            }),
        ).rejects.toThrow(/status 500/);
    });

    it("falls back on a network error when fallback is provided", async () => {
        await expect(
            run({
                fallback: { offline: true },
                fetchImpl: async () => {
                    throw new Error("offline");
                },
            }),
        ).resolves.toEqual({ offline: true });
    });

    it("throws on a network error without fallback", async () => {
        await expect(
            run({
                fetchImpl: async () => {
                    throw new Error("offline");
                },
            }),
        ).rejects.toThrow(/network error/i);
    });

    it("falls back on invalid JSON when fallback is provided", async () => {
        await expect(
            run({
                fallback: { parsed: false },
                fetchImpl: async () => mockResponse("<<not json>>"),
            }),
        ).resolves.toEqual({ parsed: false });
    });
});
