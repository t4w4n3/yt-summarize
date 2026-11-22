/**
 * Pipeline error contracts owned by the application layer (phase 1D).
 * `StageError` carries the stage that produced an error plus truncated
 * detail for the friendly mapping in `./friendly-error.ts`. The worker's
 * `stages/process.ts` re-exports this class so existing import paths work.
 */

/** Error carrying the pipeline stage that produced it, for friendly mapping. */
export class StageError extends Error {
  stage: string;
  details: string;

  constructor(message: string, stage: string, details = '', options?: ErrorOptions) {
    super(message, options);
    this.name = 'StageError';
    this.stage = stage;
    this.details = details;
  }
}

/** Any error escaping the pipeline carries the stage it failed in. */
export type StagedError = Error & { stage?: string | null };
