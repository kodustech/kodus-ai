import { notFound } from "next/navigation";
import { isKodyRuntimeReleased } from "src/core/feature-gate/kody-runtime";

import KodyRuntimeRepositoryRoute from "../settings/code-review/[repositoryId]/kody-runtime/page";
import RuntimeLayout from "./layout";

jest.mock("next/navigation", () => ({
    notFound: jest.fn(() => {
        throw new Error("NEXT_NOT_FOUND");
    }),
}));
jest.mock("src/core/feature-gate/kody-runtime", () => ({
    isKodyRuntimeReleased: jest.fn(),
}));
jest.mock(
    "../settings/code-review/[repositoryId]/kody-runtime/_page-component",
    () => ({ KodyRuntimeRepositoryPage: () => null }),
);

describe("the Kody Runtime routes", () => {
    beforeEach(() => jest.clearAllMocks());

    it("are not found for an org Kody Runtime is not released to", async () => {
        (isKodyRuntimeReleased as jest.Mock).mockResolvedValue(false);
        await expect(RuntimeLayout({ children: null })).rejects.toThrow(
            "NEXT_NOT_FOUND",
        );
        await expect(KodyRuntimeRepositoryRoute()).rejects.toThrow(
            "NEXT_NOT_FOUND",
        );
        expect(notFound).toHaveBeenCalledTimes(2);
    });

    it("render for an org it is released to", async () => {
        (isKodyRuntimeReleased as jest.Mock).mockResolvedValue(true);
        await expect(RuntimeLayout({ children: null })).resolves.toBeTruthy();
        await expect(KodyRuntimeRepositoryRoute()).resolves.toBeTruthy();
        expect(notFound).not.toHaveBeenCalled();
    });
});
