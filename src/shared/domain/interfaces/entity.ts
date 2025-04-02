export interface Entity<T> {
    toObject(): T;
    toJson(): T | Partial<T>;
}
