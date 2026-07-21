/** Base class for errors this extension raises deliberately. */
export class CsesError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Network or HTTP-level failure talking to cses.fi. */
export class NetworkError extends CsesError {}

/** The page loaded but did not have the shape the scraper expects. */
export class ParseError extends CsesError {
  constructor(
    message: string,
    readonly context?: string,
  ) {
    super(message);
  }
}

/** The user is not logged in, or the stored session has expired. */
export class AuthError extends CsesError {}

/** Compiling the user's solution failed. */
export class CompilationError extends CsesError {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
