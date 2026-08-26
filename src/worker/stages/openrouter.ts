import { OpenRouterSecretError, resolveOpenRouterKey as resolveFromShared } from '../../shared/secrets.ts';
import { StageError } from './process.ts';

/**
 * Resolve the OpenRouter API key.
 * Delegates to the single contract in shared/secrets.ts (P4) and translates
 * secret-resolution failures into StageErrors so `shared` never depends on `worker`.
 * The plaintext is kept in worker memory for the lifetime of a single
 * request and never written to disk.
 */
export async function resolveOpenRouterKey(): Promise<string> {
  try {
    const key = await resolveFromShared();
    if (key) return key;
  } catch (error) {
    if (error instanceof OpenRouterSecretError) {
      // Secret validation/decryption is translated at the worker boundary so
      // the pipeline can attribute the failure without coupling shared to it.
      throw new StageError(
        'Could not resolve the OpenRouter credential. Check the podman secret and worker logs.',
        'pipeline',
        error.message,
        { cause: error },
      );
    }
    const details = error instanceof Error ? error.message : String(error);
    throw new StageError('Could not read the OpenRouter secret.', 'pipeline', details, { cause: error });
  }

  throw new StageError(
    'Could not resolve the OpenRouter credential. Check the GPG mounts and worker logs.',
    'pipeline',
    `no secret at /run/secrets/openrouter_key and no legacy file at /secrets/openrouter.gpg`,
  );
}
