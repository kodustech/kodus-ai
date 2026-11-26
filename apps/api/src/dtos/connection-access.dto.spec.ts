import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { SetConnectionAccessDto } from './connection-access.dto';

const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
});
const parse = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: SetConnectionAccessDto });

describe('SetConnectionAccessDto', () => {
    const u1 = '2f1d0c6e-4b8a-4c1e-9a5d-3e7f6b2a1c90';
    const u2 = '7a3b9e21-0c4d-4f6a-8b2e-1d5c9f0e3a47';

    it('accepts a list of member ids, including an empty one', async () => {
        await expect(parse({ userIds: [u1, u2] })).resolves.toEqual({
            userIds: [u1, u2],
        });
        await expect(parse({ userIds: [] })).resolves.toEqual({ userIds: [] });
    });

    it.each([
        [{}],
        [{ userIds: 'u1' }],
        [{ userIds: [1] }],
        [{ userIds: null }],
        [{ userIds: ['not-a-uuid'] }],
        [{ userIds: Array.from({ length: 5001 }, () => u1) }],
    ])('refuses %j instead of clearing every grant', async (body) => {
        await expect(parse(body)).rejects.toThrow(BadRequestException);
    });
});
