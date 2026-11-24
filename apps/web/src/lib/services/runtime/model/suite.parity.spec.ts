import { FULL_REASONS } from "@libs/runtime/suite/select";

import { FULL_REASON_TEXT } from "./suite";

/**
 * The web says why the whole suite ran in its own words (the isolated web build copies no runtime lib), keyed by the Runtime's
 * reasons. A reason the Runtime adds and the web does not know would read as its raw name on the page.
 */
describe("the reasons the whole suite ran (web ↔ libs/runtime)", () => {
    it("has a sentence for every reason the Runtime can give, and none the Runtime does not", () => {
        expect(Object.keys(FULL_REASON_TEXT).sort()).toEqual(
            [...FULL_REASONS].sort(),
        );
    });
});
