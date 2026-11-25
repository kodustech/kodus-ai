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
    it('accepts a list of member ids, including an empty one', async () => {
        await expect(parse({ userIds: ['u1', 'u2'] })).resolves.toEqual({
            userIds: ['u1', 'u2'],
        });
        await expect(parse({ userIds: [] })).resolves.toEqual({ userIds: [] });
    });

    it.each([
        [{}],
        [{ userIds: 'u1' }],
        [{ userIds: [1] }],
        [{ userIds: null }],
    ])('refuses %j instead of clearing every grant', async (body) => {
        await expect(parse(body)).rejects.toThrow(BadRequestException);
    });
});
