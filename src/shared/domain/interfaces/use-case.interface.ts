export interface IUseCase {
    execute(...params: unknown[]): Promise<unknown>;
}
