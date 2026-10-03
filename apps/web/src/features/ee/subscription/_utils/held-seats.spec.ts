import { heldSeats } from "./held-seats";

describe("heldSeats", () => {
    it("leaves out seats that were released", () => {
        expect(
            heldSeats([
                { git_id: "1", status: "active" },
                { git_id: "2", status: "inactive" },
            ]),
        ).toEqual([{ git_id: "1", status: "active" }]);
    });

    it("keeps entries with no status, as cloud sends them", () => {
        expect(heldSeats([{ git_id: "1" }, { git_id: "2" }])).toEqual([
            { git_id: "1" },
            { git_id: "2" },
        ]);
    });
});
