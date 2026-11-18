import { BLOCKER_KINDS } from "@libs/runtime/contracts/enums";

import { blockerKindLabel } from "./labels";

// The web's BlockerKind is the runtime's (contracts/enums.ts); this pins its
// labels to every kind the runtime can record.
describe("blocker kind labels", () => {
    it.each(BLOCKER_KINDS.map((k) => [k]))(
        "%s shows words, not its raw name",
        (kind) => {
            expect(blockerKindLabel(kind)).not.toBe(kind);
        },
    );
});
