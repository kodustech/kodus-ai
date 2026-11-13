import { readFileSync } from "fs";
import { join } from "path";
import { CookieJar, JSDOM } from "jsdom";

import { FIRST_TOUCH_COOKIE, parseFirstTouchCookie } from "./first-touch";

/**
 * Runs the GTM tag exactly as pasted into the containers, in real jsdom
 * windows that share one cookie jar, so the .kodus.io cookie crosses from the
 * marketing site to the app the way it does in a browser.
 */
const TAG = readFileSync(join(__dirname, "gtm-first-touch.html"), "utf8");
// The file is a single <script> element, as pasted into GTM.
const SCRIPT = TAG.slice(TAG.indexOf(">") + 1, TAG.lastIndexOf("</script>"));

const visit = (jar: CookieJar, url: string, referrer = "") => {
    const dom = new JSDOM(
        "<!doctype html><html><head></head><body></body></html>",
        {
            url,
            referrer: referrer || undefined,
            cookieJar: jar,
            runScripts: "outside-only",
        },
    );
    dom.window.eval(SCRIPT);
    return dom.window.document.cookie;
};

const firstTouchOn = (jar: CookieJar, url: string) => {
    const entry = jar
        .getCookiesSync(url)
        .find((cookie) => cookie.key === FIRST_TOUCH_COOKIE);
    return entry ? parseFirstTouchCookie(entry.value) : undefined;
};

describe("GTM first-touch tag", () => {
    it("records the ad click on kodus.io and the app sees it", () => {
        const jar = new CookieJar();

        visit(
            jar,
            "https://kodus.io/?utm_source=google&utm_medium=cpc&utm_campaign=test&gclid=TEST&fbclid=drop&email=jane%40acme.com#hero",
            "https://www.google.com/search?q=code+review",
        );

        const touch = firstTouchOn(jar, "https://app.kodus.io/sign-up");
        expect(touch).toEqual({
            utm_source: "google",
            utm_medium: "cpc",
            utm_campaign: "test",
            gclid: "TEST",
            referrer: "https://www.google.com/search",
            landing_page:
                "https://kodus.io/?utm_source=google&utm_medium=cpc&utm_campaign=test&gclid=TEST",
            captured_at: expect.any(String),
        });

        const cookie = jar
            .getCookiesSync("https://app.kodus.io/")
            .find((c) => c.key === FIRST_TOUCH_COOKIE);
        expect(cookie?.domain).toBe("kodus.io");
        expect(cookie?.secure).toBe(true);
        expect(cookie?.sameSite).toBe("lax");
    });

    it("never overwrites the first touch on a later visit", () => {
        const jar = new CookieJar();
        visit(jar, "https://kodus.io/?utm_source=google&gclid=TEST");
        const first = firstTouchOn(jar, "https://app.kodus.io/");

        visit(
            jar,
            "https://kodus.io/en/pricing/?utm_source=linkedin&utm_medium=paid_social",
        );
        visit(jar, "https://app.kodus.io/sign-up?utm_source=newsletter");

        expect(firstTouchOn(jar, "https://app.kodus.io/")).toEqual(first);
        expect(first?.utm_source).toBe("google");
    });

    describe("creator links", () => {
        const DAY = 24 * 60 * 60;
        const CREATOR = "https://kodus.io/?utm_medium=creator&utm_campaign=joao123";

        const cookieOn = (jar: CookieJar) =>
            jar
                .getCookiesSync("https://app.kodus.io/")
                .find((c) => c.key === FIRST_TOUCH_COOKIE);

        afterEach(() => jest.useRealTimers());

        it("replaces an earlier first touch and lasts 90 days", () => {
            const jar = new CookieJar();
            visit(jar, "https://kodus.io/", "https://www.google.com/");
            expect(cookieOn(jar)?.maxAge).toBe(365 * DAY);

            visit(jar, CREATOR, "https://www.youtube.com/");

            expect(firstTouchOn(jar, "https://app.kodus.io/")).toEqual({
                utm_medium: "creator",
                utm_campaign: "joao123",
                referrer: "https://www.youtube.com/",
                landing_page:
                    "https://kodus.io/?utm_medium=creator&utm_campaign=joao123",
                captured_at: expect.any(String),
            });
            expect(cookieOn(jar)?.maxAge).toBe(90 * DAY);
        });

        it("is kept when the visitor comes back another way", () => {
            const jar = new CookieJar();
            visit(jar, CREATOR);

            visit(jar, "https://kodus.io/", "https://www.google.com/");
            visit(jar, "https://kodus.io/?utm_source=fb&utm_medium=paid");

            expect(
                firstTouchOn(jar, "https://app.kodus.io/")?.utm_campaign,
            ).toBe("joao123");
        });

        it("gives way to the next creator link clicked", () => {
            const jar = new CookieJar();
            visit(jar, CREATOR);
            visit(
                jar,
                "https://app.kodus.io/sign-up?utm_medium=Creator&utm_campaign=ana456",
            );

            const touch = firstTouchOn(jar, "https://app.kodus.io/");
            expect(touch?.utm_campaign).toBe("ana456");
            // Stored in the form the commission query matches.
            expect(touch?.utm_medium).toBe("creator");
            expect(touch?.landing_page).toBe(
                "https://app.kodus.io/sign-up?utm_medium=creator&utm_campaign=ana456",
            );
        });

        // Moves the jar's clock with no read in between: tough-cookie counts
        // Max-Age from the last access, where a browser fixes the expiry when
        // the cookie is written, so a read here would push the expiry out.
        it("expires after 90 days, and the next visit records how they came back", () => {
            jest.useFakeTimers({ now: new Date("2026-01-01T12:00:00Z") });
            const jar = new CookieJar();
            visit(jar, CREATOR);

            jest.setSystemTime(new Date("2026-04-02T12:00:00Z")); // day 91
            visit(jar, "https://kodus.io/", "https://www.google.com/");

            const touch = firstTouchOn(jar, "https://app.kodus.io/");
            expect(touch?.utm_campaign).toBeUndefined();
            expect(touch?.referrer).toBe("https://www.google.com/");
            expect(cookieOn(jar)?.maxAge).toBe(365 * DAY);
        });

        it("is written again, with a new 90 days, when a creator link is clicked again", () => {
            const jar = new CookieJar();
            visit(jar, CREATOR);
            visit(
                jar,
                "https://kodus.io/pricing/?utm_medium=creator&utm_campaign=joao123",
            );

            expect(firstTouchOn(jar, "https://app.kodus.io/")?.landing_page).toBe(
                "https://kodus.io/pricing/?utm_medium=creator&utm_campaign=joao123",
            );
            expect(cookieOn(jar)?.maxAge).toBe(90 * DAY);
        });

        it.each([
            ["no creator id", "https://kodus.io/?utm_medium=creator"],
            [
                "an email as the creator id",
                "https://kodus.io/?utm_medium=creator&utm_campaign=jane%40acme.com",
            ],
        ])("counts a link with %s as any other visit", (_label, url) => {
            const jar = new CookieJar();
            visit(jar, CREATOR);
            visit(jar, url);

            // The real creator link is kept, with its 90 days (365 before
            // creator links existed).
            expect(firstTouchOn(jar, "https://app.kodus.io/")?.landing_page).toBe(
                CREATOR,
            );
            expect(cookieOn(jar)?.maxAge).toBe(90 * DAY);
        });
    });

    it("records only referrer and landing page for a visit without parameters", () => {
        const jar = new CookieJar();
        visit(
            jar,
            "https://kodus.io/en/blog/post/?ref=x",
            "https://news.ycombinator.com/item?id=1",
        );

        expect(firstTouchOn(jar, "https://kodus.io/")).toEqual({
            referrer: "https://news.ycombinator.com/item",
            landing_page: "https://kodus.io/en/blog/post/",
            captured_at: expect.any(String),
        });
    });

    it("records only the landing page for a direct visit", () => {
        const jar = new CookieJar();
        visit(jar, "https://kodus.io/");

        expect(firstTouchOn(jar, "https://kodus.io/")).toEqual({
            landing_page: "https://kodus.io/",
            captured_at: expect.any(String),
        });
    });

    it("drops parameter values that carry an email", () => {
        const jar = new CookieJar();
        visit(
            jar,
            "https://kodus.io/?utm_source=newsletter&utm_content=jane%40acme.com",
        );

        expect(firstTouchOn(jar, "https://kodus.io/")).toEqual({
            utm_source: "newsletter",
            landing_page: "https://kodus.io/?utm_source=newsletter",
            captured_at: expect.any(String),
        });
    });

    it("drops an email whose @ arrives percent-encoded", () => {
        const jar = new CookieJar();
        // Double-encoded in the ad URL, so it reaches the tag as jane%40acme.com.
        visit(
            jar,
            "https://kodus.io/?utm_source=newsletter&utm_term=jane%2540acme.com",
        );

        expect(firstTouchOn(jar, "https://kodus.io/")).toEqual({
            utm_source: "newsletter",
            landing_page: "https://kodus.io/?utm_source=newsletter",
            captured_at: expect.any(String),
        });
    });

    it("drops an email that starts before the 100-character cut", () => {
        const jar = new CookieJar();
        visit(
            jar,
            `https://kodus.io/?utm_source=newsletter&utm_content=${"x".repeat(95)}%20jane%40acme.com`,
        );

        expect(
            firstTouchOn(jar, "https://kodus.io/")?.utm_content,
        ).toBeUndefined();
    });

    it("keeps the attribution when the 100-character cut lands inside an emoji", () => {
        const jar = new CookieJar();
        visit(
            jar,
            `https://kodus.io/?utm_source=google&utm_content=${"x".repeat(99)}${encodeURIComponent("\u{1F600}")}`,
        );

        const touch = firstTouchOn(jar, "https://kodus.io/");
        expect(touch?.utm_source).toBe("google");
        expect(touch?.utm_content).toBe("x".repeat(99));
    });

    it("does not leave half a percent escape when it cuts a long landing page", () => {
        const jar = new CookieJar();
        // The path is cut at 300 characters, inside "%C3".
        visit(jar, `https://kodus.io/${"a".repeat(297)}%C3%A9`);

        expect(firstTouchOn(jar, "https://kodus.io/")?.landing_page).toBe(
            `https://kodus.io/${"a".repeat(297)}`,
        );
    });

    // é, ✓ and 😀 take 2, 3 and 4 bytes; the padding moves the 300-character
    // cut through every byte of the last character that fits.
    it.each(["é", "✓", "😀"])(
        "cuts a non-ASCII landing page between characters, never inside one (%s)",
        (character) => {
            for (let pad = 0; pad < 12; pad++) {
                const jar = new CookieJar();
                const url = `https://kodus.io/${"a".repeat(pad)}${character.repeat(100)}`;
                visit(jar, url);

                const landingPage = firstTouchOn(jar, "https://kodus.io/")
                    ?.landing_page as string;
                expect(url.startsWith(decodeURIComponent(landingPage))).toBe(
                    true,
                );
                expect(landingPage.length).toBeGreaterThan(
                    "https://kodus.io".length + 300 - 12,
                );
            }
        },
    );

    it("does nothing outside kodus.io (self-hosted installs load the app container too)", () => {
        const jar = new CookieJar();
        visit(jar, "https://kodus.acme.internal/sign-up?utm_source=google");
        visit(jar, "https://notkodus.io/?utm_source=google");

        expect(jar.getCookiesSync("https://kodus.acme.internal/")).toHaveLength(
            0,
        );
        expect(jar.getCookiesSync("https://notkodus.io/")).toHaveLength(0);
    });

    it("does nothing on QA, preview or e2e hosts, whose cookie would reach production", () => {
        const jar = new CookieJar();
        visit(jar, "https://qa.web.kodus.io/sign-up?utm_source=qa");
        visit(jar, "https://pr-2305.preview.kodus.io/?utm_source=preview");
        visit(jar, "https://cloud-e2e.kodus.io/?utm_source=e2e");

        expect(firstTouchOn(jar, "https://app.kodus.io/")).toBeUndefined();

        visit(jar, "https://www.kodus.io/?utm_source=google");
        expect(firstTouchOn(jar, "https://app.kodus.io/")?.utm_source).toBe(
            "google",
        );
    });

    it("keeps the worst-case cookie under the browser limit, with consistent values", () => {
        const jar = new CookieJar();
        // 3-byte characters grow the most once encoded twice.
        const long = encodeURIComponent("€".repeat(100));
        const params = [
            "utm_source",
            "utm_medium",
            "utm_campaign",
            "utm_term",
            "utm_content",
        ];
        const gclid = "Cj0K_" + "a".repeat(225);
        visit(
            jar,
            `https://kodus.io/${"p".repeat(400)}?${params.map((p) => `${p}=${long}`).join("&")}&gclid=${gclid}`,
            `https://example.com/${"r".repeat(400)}`,
        );

        const cookie = jar
            .getCookiesSync("https://kodus.io/")
            .find((c) => c.key === FIRST_TOUCH_COOKIE);
        expect(cookie).toBeDefined();
        expect(cookie!.value.length).toBeLessThan(3500);

        const touch = parseFirstTouchCookie(cookie!.value)!;
        // The size fallback ran: shorter values, the landing page without a
        // query rather than one that disagrees with the fields, and the click
        // id still whole.
        for (const p of params) expect(touch[p]).toBe("€".repeat(40));
        expect(touch.gclid).toBe(gclid);
        expect(touch.landing_page).toBe(`https://kodus.io/${"p".repeat(99)}`);
    });

    it.each([
        ["too long", "a".repeat(256)],
        ["malformed", "abc%3Cscript%3E"],
    ])("drops a gclid that is %s", (_label, gclid) => {
        const jar = new CookieJar();
        visit(jar, `https://kodus.io/?utm_source=x&gclid=${gclid}`);

        expect(firstTouchOn(jar, "https://kodus.io/")).toEqual({
            utm_source: "x",
            landing_page: "https://kodus.io/?utm_source=x",
            captured_at: expect.any(String),
        });
    });
});
