import { HttpException } from '@nestjs/common';
import type { z } from 'zod';

/** zod at the edge: a body that does not parse is a 400 with the schema message. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
    const r = schema.safeParse(body);
    if (!r.success) throw new HttpException({ code: 'invalid_body', message: r.error.message }, 400);
    return r.data;
}
