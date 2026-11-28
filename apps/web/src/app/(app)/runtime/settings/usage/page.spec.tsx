import { redirect } from "next/navigation";

import RuntimeUsageRoute from "./page";

jest.mock("next/navigation", () => ({ redirect: jest.fn() }));

describe("the old Runtime usage route", () => {
    it("redirects to the Runtime tab of Usage", () => {
        RuntimeUsageRoute();
        expect(redirect).toHaveBeenCalledWith("/token-usage?tab=runtime");
    });
});
