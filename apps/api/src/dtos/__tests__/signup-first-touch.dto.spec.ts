import {
    ArgumentMetadata,
    BadRequestException,
    ValidationPipe,
} from '@nestjs/common';

import { AuthProvider } from '@libs/core/domain/enums/auth-provider.enum';
import { SignUpDTO } from '@libs/identity/dtos/create-user-organization.dto';

import { CreateUserOrganizationOAuthDto } from '../create-user-organization-oauth.dto';

// Same options as the global pipe in apps/api/src/main.ts. With
// forbidNonWhitelisted, a field the DTO does not declare is a 400, so this
// locks in that `firstTouch` is accepted on both signup paths and that what is
// inside it is left to sanitizeFirstTouch instead of failing the signup.
const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
});

const run = (metatype: ArgumentMetadata['metatype'], body: unknown) =>
    pipe.transform(body, { type: 'body', metatype });

const firstTouch = {
    utm_source: 'google',
    utm_medium: 'cpc',
    gclid: 'TEST',
    landing_page: 'https://kodus.io/?utm_source=google',
    captured_at: '2026-10-29T11:59:00.000Z',
    // Not a known key: must reach the sanitizer, which drops it, rather than
    // turn the whole signup into a 400.
    fbclid: 'x',
    nested: { anything: [1, 2] },
};

describe('firstTouch on the signup DTOs', () => {
    const signUp = {
        name: 'Jane',
        email: 'jane@acme.com',
        password: 'Str0ngP@ssw0rd!',
    };
    const oauth = {
        name: 'Jane',
        email: 'jane@acme.com',
        refreshToken: 'token',
        authProvider: AuthProvider.GITHUB,
    };

    it.each([
        ['SignUpDTO', SignUpDTO, signUp],
        [
            'CreateUserOrganizationOAuthDto',
            CreateUserOrganizationOAuthDto,
            oauth,
        ],
    ])(
        '%s accepts it and passes it through untouched',
        async (_n, dto, body) => {
            const out = await run(dto, { ...body, firstTouch });

            expect(out.firstTouch).toEqual(firstTouch);
        },
    );

    it.each([
        ['SignUpDTO', SignUpDTO, signUp],
        [
            'CreateUserOrganizationOAuthDto',
            CreateUserOrganizationOAuthDto,
            oauth,
        ],
    ])('%s still accepts a body without it', async (_n, dto, body) => {
        const out = await run(dto, body);

        expect(out.firstTouch).toBeUndefined();
    });

    it('rejects a non-object value', async () => {
        await expect(
            run(SignUpDTO, { ...signUp, firstTouch: 'utm_source=google' }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});
