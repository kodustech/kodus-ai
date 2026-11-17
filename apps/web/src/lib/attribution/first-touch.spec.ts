/**
 * @jest-environment jsdom
 */
import {
    FIRST_TOUCH_COOKIE,
    parseFirstTouchCookie,
    readFirstTouchFromDocument,
} from "./first-touch";

const touch = {
    utm_source: "google",
    landing_page: "https://kodus.io/?utm_source=google%20ads",
};

describe("parseFirstTouchCookie", () => {
    it("reads the raw value from document.cookie", () => {
        expect(
            parseFirstTouchCookie(encodeURIComponent(JSON.stringify(touch))),
        ).toEqual(touch);
    });

    it("reads a value Next's cookies() already decoded, without decoding it twice", () => {
        // A second decode would turn %20 into a space and %zz into a throw.
        expect(parseFirstTouchCookie(JSON.stringify(touch))).toEqual(touch);
        expect(
            parseFirstTouchCookie(JSON.stringify({ utm_term: "50%zz" })),
        ).toEqual({ utm_term: "50%zz" });
    });

    it.each([
        undefined,
        null,
        "",
        "garbage",
        "%E0%A4%A",
        "[1,2]",
        "null",
        "42",
    ])("returns undefined for %p", (value) => {
        expect(parseFirstTouchCookie(value)).toBeUndefined();
    });
});

describe("readFirstTouchFromDocument", () => {
    afterEach(() => {
        document.cookie = `${FIRST_TOUCH_COOKIE}=; Max-Age=0; Path=/`;
    });

    it("returns undefined without the cookie", () => {
        document.cookie = "other=1; Path=/";
        expect(readFirstTouchFromDocument()).toBeUndefined();
    });

    it("returns undefined when reading cookies throws", () => {
        const spy = jest
            .spyOn(document, "cookie", "get")
            .mockImplementation(() => {
                throw new DOMException(
                    "The operation is insecure.",
                    "SecurityError",
                );
            });
        try {
            expect(readFirstTouchFromDocument()).toBeUndefined();
        } finally {
            spy.mockRestore();
        }
    });

    it("finds it among other cookies", () => {
        document.cookie = "pll_language=pt; Path=/";
        document.cookie = `${FIRST_TOUCH_COOKIE}=${encodeURIComponent(
            JSON.stringify(touch),
        )}; Path=/`;

        expect(readFirstTouchFromDocument()).toEqual(touch);
    });
});
