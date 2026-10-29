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
        // "https://kodus.io/" + 281 chars = 298; the 300-char cut lands in "%C3".
        visit(jar, `https://kodus.io/${"a".repeat(281)}%C3%A9`);

        expect(firstTouchOn(jar, "https://kodus.io/")?.landing_page).toBe(
            `https://kodus.io/${"a".repeat(281)}`,
        );
    });

    it("does nothing outside kodus.io (self-hosted installs load the app container too)", () => {
        const jar = new CookieJar();
        visit(jar, "https://kodus.acme.internal/sign-up?utm_source=google");
        visit(jar, "https://notkodus.io/?utm_source=google");

        expect(jar.getCookiesSync("https://kodus.acme.internal/")).toHaveLength(
            0,
        );
        expect(jar.getCookiesSync("https://notkodus.io/")).toHaveLength(0);
    });

    it("keeps the cookie under the browser size limit", () => {
        const jar = new CookieJar();
        const long = encodeURIComponent("ã".repeat(100));
        visit(
            jar,
            `https://kodus.io/?utm_source=${long}&utm_medium=${long}&utm_campaign=${long}&utm_term=${long}&utm_content=${long}`,
        );

        const cookie = jar
            .getCookiesSync("https://kodus.io/")
            .find((c) => c.key === FIRST_TOUCH_COOKIE);
        expect(cookie).toBeDefined();
        expect(cookie!.value.length).toBeLessThan(4000);
        expect(parseFirstTouchCookie(cookie!.value)?.utm_source).toBe(
            "ã".repeat(40),
        );
    });
});
