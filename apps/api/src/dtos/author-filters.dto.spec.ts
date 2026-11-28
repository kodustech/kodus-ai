import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { UpdateAuthorFiltersDto } from './author-filters.dto';

const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
});
const parse = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: UpdateAuthorFiltersDto });

describe('UpdateAuthorFiltersDto', () => {
    const connectionId = '7a3b9e21-0c4d-4f6a-8b2e-1d5c9f0e3a47';

    it("accepts a connection's lists, and the organization's without one", async () => {
        await expect(
            parse({ connectionId, ignoredUsers: ['7'], allowedUsers: [] }),
        ).resolves.toEqual({
            connectionId,
            ignoredUsers: ['7'],
            allowedUsers: [],
        });
        await expect(
            parse({ ignoredUsers: [], allowedUsers: ['3'] }),
        ).resolves.toEqual({ ignoredUsers: [], allowedUsers: ['3'] });
    });

    it.each([
        [{ ignoredUsers: [] }],
        [{ connectionId: 'gl-b', ignoredUsers: [], allowedUsers: [] }],
        [{ ignoredUsers: [1], allowedUsers: [] }],
        [{ ignoredUsers: [], allowedUsers: [], configValue: {} }],
    ])('refuses %j', async (body) => {
        await expect(parse(body)).rejects.toThrow(BadRequestException);
    });
});
