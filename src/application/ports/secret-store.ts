/**
 * Outbound port for OpenRouter credential resolution.
 * The application layer owns the contract; the filesystem/GPG adapter in
 * `shared/secrets.ts` implements it.
 */
export type OpenRouterSecretErrorCode = 'invalid-secret' | 'decryption-failed';

/** Stable failure type for OpenRouter credential resolution across module boundaries. */
export class OpenRouterSecretError extends Error {
  readonly code: OpenRouterSecretErrorCode;

  constructor(message: string, code: OpenRouterSecretErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OpenRouterSecretError';
    this.code = code;
  }
}

export interface SecretStore {
  /**
   * Resolve the OpenRouter API key.
   * Returns the key string when found, null when missing (placeholder counts as missing).
   * Throws an OpenRouterSecretError when a configured secret is invalid or GPG decryption fails.
   */
  resolveOpenRouterKey(): Promise<string | null>;
}
