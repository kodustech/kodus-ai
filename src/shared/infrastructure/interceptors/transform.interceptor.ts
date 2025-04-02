import { isRabbitContext } from '@golevelup/nestjs-rabbitmq';
import {
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
    StreamableFile,
} from '@nestjs/common';
import { type } from 'ramda';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface Response<T> {
    statusCode: number;
    data?: T;
}

@Injectable()
export class TransformInterceptor<T>
    implements NestInterceptor<T, Response<T>>
{
    intercept(
        context: ExecutionContext,
        next: CallHandler,
    ): Observable<Response<T> | any> {
        const shouldSkip = isRabbitContext(context);

        if (shouldSkip) {
            return next.handle().pipe();
        }

        return next.handle().pipe(
            map((data?: any) => {
                if (data instanceof StreamableFile) {
                    return data;
                }

                const response = context.switchToHttp().getResponse();

                if ([undefined].includes(data)) {
                    response.status(204);
                    return;
                } else if (data === null) {
                    response.status(404);
                    return;
                }

                return {
                    data,
                    statusCode: context.switchToHttp().getResponse().statusCode,
                    type: type(data),
                };
            }),
        );
    }
}
