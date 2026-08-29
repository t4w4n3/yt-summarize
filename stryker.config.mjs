/**
 * StrykerJS — mutation testing POC for summarize-yt.
 *
 * Scope initial : domain pur uniquement (rapide, hermétique).
 * Runner : `command` → `node --test` natif (Node 24 type-stripping, pas de build).
 * Checker désactivé sur le POC pour vitesse ; réactiver `typescript` quand
 * on étendra à worker/shared.
 *
 * Usage:
 *   pnpm run mutation              # domain (défaut)
 *   pnpm run mutation:domain       # idem explicite
 *   pnpm run mutation:all          # tout src (lent)
 *   mise run mutation              # wrapper mise (même chose)
 *
 * Config alternative via CLI :
 *   npx stryker run --mutate src/domain/transcription/policy.ts --testRunner command --commandRunner.command "node --test 'tests/unit/transcription-policy.test.ts'"
 */
// @ts-nocheck

const base = {
  // par défaut: uniquement le domain (POC). Surchargé par `mutation:all`.
  mutate: ['src/domain/**/*.ts', '!src/domain/**/*.test.ts'],
  ignorePatterns: ['node_modules', '.git', 'test-results', '.local', 'e2e', '.stryker-tmp'],
  testRunner: 'command',
  // `command` runner → natif `node --test` (Node 24 type-stripping).
  // On couvre unit+integration pour que shared/worker soient tués; le POC domain
  // reste rapide car seuls les fichiers `mutate` changent.
  commandRunner: {
    command: "node --test 'tests/unit/**/*.test.ts' 'tests/integration/**/*.test.ts'",
  },
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: 'test-results/mutation/index.html' },
  // integration gate ~6–8s; sandbox (TS 6) permet plus de parallélisme sans contention
  timeoutMS: 10000,
  timeoutFactor: 1.5,
  dryRunTimeoutMinutes: 2,
  concurrency: 4,
  coverageAnalysis: 'off',
  checkers: [],
  inPlace: false,
  // Logs utiles pour debug initial, passer à warn ensuite
  logLevel: 'info',
  fileLogLevel: 'off',
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
  thresholds: { high: 80, low: 60, break: null },
  disableBail: false,
};

export default base;
