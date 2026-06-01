import * as mongoose from 'mongoose';
import { PullRequestsSchema } from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';

describe('PullRequests schema — Bug B2 regression', () => {
    // Build a real Mongoose model from the exported schema so we exercise
    // the actual validation rules the production code enforces at write time.
    const Model = mongoose.model('PullRequestsTest_B2', PullRequestsSchema);

    const minimalValidDoc = {
        title: 'chore: test',
        status: 'open',
        number: 42,
        merged: false,
        url: 'https://example.com/pr/42',
        baseBranchRef: 'main',
        headBranchRef: 'feature-x',
        openedAt: '2026-04-24T00:00:00Z',
        organizationId: 'org-1',
        provider: 'GITHUB',
    };

    it('accepts a PullRequests document WITHOUT "files" (partial upsert flow)', () => {
        // Reproduces the "Path 'files' is required" crash seen on partial
        // updates (e.g. bumping status/merged without re-sending the payload).
        const doc = new Model(minimalValidDoc);
        const err = doc.validateSync();

        expect(err).toBeUndefined();
    });

    it('defaults "files" to an empty array when omitted', () => {
        const doc = new Model(minimalValidDoc);
        expect(doc.files).toEqual([]);
    });

    it('still accepts a PullRequests document WITH "files" populated', () => {
        const doc = new Model({
            ...minimalValidDoc,
            files: [
                {
                    id: 'f1',
                    path: 'src/foo.ts',
                    filename: 'foo.ts',
                    previousName: '',
                    status: 'modified',
                    createdAt: '2026-04-24T00:00:00Z',
                    updatedAt: '2026-04-24T00:00:00Z',
                    added: 1,
                    deleted: 0,
                    changes: 1,
                    suggestions: [],
                },
            ],
        });
        const err = doc.validateSync();

        expect(err).toBeUndefined();
        expect(doc.files).toHaveLength(1);
    });
});
