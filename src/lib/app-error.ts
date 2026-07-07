export class AppError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
