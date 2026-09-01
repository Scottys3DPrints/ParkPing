import type { ApiErrorBody } from '@parkping/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ApiErrorBody['error']['details'],
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody(): ApiErrorBody {
    const error: ApiErrorBody['error'] = { code: this.code, message: this.message };
    if (this.details) error.details = this.details;
    if (this.retryAfter !== undefined) error.retryAfter = this.retryAfter;
    return { error };
  }
}

export const badRequest = (code: string, message: string, details?: ApiErrorBody['error']['details']) =>
  new ApiError(400, code, message, details);

export const unauthorized = (message = 'Sign in to continue.') =>
  new ApiError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have access to this resource.') =>
  new ApiError(403, 'forbidden', message);

export const notFound = (message = 'Not found.') => new ApiError(404, 'not_found', message);

export const conflict = (code: string, message: string) => new ApiError(409, code, message);

export const tooManyRequests = (message: string, retryAfter: number, code = 'rate_limited') =>
  new ApiError(429, code, message, undefined, retryAfter);

export const serverError = (message = 'Something went wrong.') =>
  new ApiError(500, 'internal_error', message);
