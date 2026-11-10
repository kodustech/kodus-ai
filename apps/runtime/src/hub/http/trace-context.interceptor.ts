import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { context } from '@opentelemetry/api';
import { Observable } from 'rxjs';

import { contextFromHeaders } from '../../shared/tracing';

/** Runs the handler inside the trace the worker sent (W3C traceparent), so hub spans join the Run's trace. */
@Injectable()
export class TraceContextInterceptor implements NestInterceptor {
    intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
        const req = ctx.switchToHttp().getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
        const parent = contextFromHeaders(req.headers ?? {});
        return new Observable((subscriber) => context.with(parent, () => next.handle().subscribe(subscriber)));
    }
}
