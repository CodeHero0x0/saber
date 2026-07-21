export class SaberError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "SaberError";
    this.exitCode = exitCode;
  }
}
