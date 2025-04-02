import { Column, ColumnOptions } from 'typeorm';

export interface VectorColumnOptions extends ColumnOptions {
    type: 'text';
    transformer: {
        to(value: number[]): string;
        from(value: string): number[];
    };
}

export const VectorColumn = (
    options?: Partial<VectorColumnOptions>,
): PropertyDecorator => {
    const columnOptions: VectorColumnOptions = {
        type: 'text',
        transformer: {
            to(value: number[]): string {
                return `[${value.join(',')}]`;
            },
            from(value: string): number[] {
                if (typeof value === 'string') {
                    return JSON.parse(value);
                }
                return value;
            },
        },
        ...options,
    };

    return Column(columnOptions);
};