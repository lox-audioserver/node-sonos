export class SonosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class TransportError extends SonosError {
  public readonly causeError?: Error;

  constructor(message: string, error?: Error) {
    super(message);
    this.causeError = error;
  }
}

export class ConnectionClosed extends TransportError {}

export class CannotConnect extends TransportError {}

export class ConnectionFailed extends TransportError {
  constructor(error?: Error) {
    super(error ? `${error.message}` : 'Connection failed.', error);
  }
}

export class NotConnected extends SonosError {}

export class InvalidState extends SonosError {}

export class InvalidMessage extends SonosError {}

export class FailedCommand extends SonosError {
  public readonly errorCode: string;
  public readonly details?: string;

  constructor(errorCode: string, details?: string) {
    super(`Command failed: ${details ?? errorCode}`);
    this.errorCode = errorCode;
    this.details = details;
  }
}
