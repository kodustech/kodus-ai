import mongoose, { Schema } from 'mongoose';

export function mongooseHideObjectId(schema: Schema): void {
    schema.set('toJSON', {
        virtuals: true,
        transform(doc, ret) {
            delete ret._id;
            delete ret.id;
            delete ret.__v;
        },
    });
    schema.set('toObject', {
        virtuals: true,
        transform(doc, ret) {
            delete ret._id;
            delete ret.id;
            delete ret.__v;
        },
    });
}

/**
 * Transforms a value into a valid MongoDB ObjectId. If the value is not a valid ObjectId,
 * returns null.
 * @param value The value to be transformed into an ObjectId.
 * @returns An ObjectId or null if the value is not a valid ObjectId.
 */
export function transformId(value: string): mongoose.Types.ObjectId | null {
    return mongoose.Types.ObjectId.isValid(value)
        ? new mongoose.Types.ObjectId(value)
        : null;
}
