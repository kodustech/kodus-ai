import { axiosAuthorized } from "src/core/utils/axios";

import {
    fetchRepositorySelection,
    previewRepositorySelection,
} from "./repositorySelection";

jest.mock("src/core/utils/axios", () => ({
    axiosAuthorized: { fetcher: jest.fn(), put: jest.fn() },
}));
jest.mock("@services/fetch", () => ({ authorizedFetch: jest.fn() }));

const fetcher = jest.mocked(axiosAuthorized.fetcher);

// What `axiosAuthorized.fetcher` resolves to for these routes: the API's
// response body, still wrapped in its envelope (observed on qa.kodus.io).
const envelope = <T,>(data: T) => ({ data, statusCode: 200, type: "Object" });

beforeEach(() => fetcher.mockReset());

it("hands the enable dialog the preview counts, not the API envelope", async () => {
    const preview = {
        visible: 5,
        eligible: 4,
        alreadySelected: 2,
        toAdd: 2,
        skipped: { archived: 0, forksAndMirrors: 1 },
    };
    fetcher.mockResolvedValue(envelope(preview) as never);

    await expect(previewRepositorySelection("team-1", false)).resolves.toEqual(
        preview,
    );
});

it("hands the progress card the selection, not the API envelope", async () => {
    const selection = {
        mode: "all",
        includeForksAndMirrors: false,
        sync: null,
    };
    fetcher.mockResolvedValue(envelope(selection) as never);

    await expect(fetchRepositorySelection("team-1")).resolves.toEqual(
        selection,
    );
});
