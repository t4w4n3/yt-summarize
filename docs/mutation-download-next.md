# Mutation — prochaine étape : `src/worker/stages/download.ts`

> Campagne StrykerJS `worker` — per-file, `TS 6.0.3 + inPlace:false` (sandbox)

## Why — pourquoi `download.ts` maintenant ?

* **Score actuel :** `45.45%` — `25 tués / 30 survivants / 0 timeout` sur 55 mutants (`npx stryker run --mutate src/worker/stages/download.ts`, `node --test 'unit+integration'`, `concurrency:4`).
  * Référence : `convert.ts` est passé `24% → 100%` en 1 commit (vérification stricte des args `ffmpeg`), `pipeline.ts` `49% → 61%` (durcissement `friendlyError`).
  * `download.ts` est le stage le plus critique (entrée de la pipeline, dépend du VPN Mullvad et du secret cookies, erreurs YouTube les plus visibles pour l'utilisateur). Un mutant qui supprime `--cookies` ou `--proxy` passe aujourd'hui sans être détecté.
* **Couverture ment :** `worker` est à `94.7% lines` mais `download.ts` n'a que 2 tests (`resolves audioPath and title`, `throws when no audio`) — aucun ne vérifie *comment* `yt-dlp` est invoqué.
* **Risque si on ne le fait pas :** régression silencieuse sur `--no-playlist`, `--print-to-file`, `bestaudio/best`, `MULLVAD_ENABLED`, `resolveYouTubeCookiesPath`, `title.slice(0,500)`.

## What — quoi tuer ?

Fichier : `src/worker/stages/download.ts` (57 lignes, `download(job, context)`).

**Survivants typiques (Stryker `clear-text`, extrait `All files 45%`) :**
* `ObjectLiteral / StringLiteral` — args `yt-dlp` : `'--no-playlist' → ""`, `'--print-to-file' → ""`, `'%(title)s' → ""`, `'bestaudio/best' → ""`, `'-o' / output` — le fake actuel `FAKE_YTDLP` n'inspecte pas `"$@"`.
* `ConditionalExpression / EqualityOperator` — `process.env.MULLVAD_ENABLED === 'true'` — `===` → `!==`, `'true' → ""` survit (aucun test avec `MULLVAD_ENABLED=true`).
* `LogicalOperator` — `process.env.MULLVAD_PROXY || 'socks5h://127.0.0.1:1080'` — `||` → `&&`, valeur par défaut jamais vérifiée.
* `ConditionalExpression` — `if (cookiesPath) args.push('--cookies', cookiesPath)` — `if` supprimé survit (fake ne vérifie pas `--cookies`).
* `CallExpression` — `args.push(job.url)` — supprimé survit (fake n'exige pas l'URL en dernier argument).
* `CallExpression / StringLiteral` — `runProcess('yt-dlp', args, { stage:'downloading', timeoutMs, logPath, onHeartbeat, signal })` — `stage` muté `downloading → ""`, `timeoutMs`/`logPath`/`signal` supprimés survivent.
* `ArrowFunction / BlockStatement` — `fs.readdirSync(...).find(name => name.startsWith('audio.') && name !== 'audio.wav')` — `startsWith` → `endsWith`, `!==` → `===` survivent.
* `ConditionalExpression / StringLiteral` — `if (!audioFile) throw new StageError('YouTube audio was not downloaded.', 'downloading')` — `!` → `!!`, message `""`, stage `""` survivent si un seul cas d'erreur est testé.
* `CallExpression / MethodExpression` — `fs.readFileSync(titlePath,'utf8').trim().split(/\r?\n/).at(-1) || 'Untitled…'` — `trim`, `split`, `at(-1)` mutés survivent (pas de test avec titre multi-ligne, `\r\n`, fichier absent).
* `StringLiteral / CallExpression` — `title.slice(0,500)` — `500 → 0`, `slice` → `substring` survivent (pas de test avec titre >500).

**Non-objectif :** les 4 `timeout` mutants de `download.ts` sont déjà tués ; on ne touche pas `transcribe.ts`/`worker-core.ts` dans ce pas.

## How — comment on tue (TDD, commits intermédiaires, pas de PR)

**Stratégie :** même pattern que `convert.ts` — faire parler le fake `yt-dlp` via un log d'args, puis durcir les assertions. Un commit par groupe de mutants, `red → green → refactor`, `mise run test` vert à chaque fois.

### 1) Vérifier les args `yt-dlp` (tue ~10 survivants `StringLiteral/CallExpression`)

*Fake actuel :*
```bash
# FAKE_YTDLP parcourt "$@" pour trouver -o, écrit .title + audio.webm, exit 0
```

*Évolution (test) :* faire logger `"$@"` dans un fichier `yt-args` puis `assert` :

```ts
const argLog = path.join(jobDir, 'yt-args');
installFake('yt-dlp', `
  printf '%s\\n' "$@" > "${argLog}"
  # ... même logique qu'avant
`);
await download(...);
const args = fs.readFileSync(argLog,'utf8').split('\n').filter(Boolean);
assert.ok(args.includes('--no-playlist'));
assert.ok(args.includes('--print-to-file'));
assert.ok(args.includes('%(title)s'));
assert.ok(args.includes('bestaudio/best'));
assert.ok(args.includes('-o'));
assert.ok(args.includes(output));
```

**Commit 1 :** `test(download): assert yt-dlp args for mutation (download 45% → ~65%)`

### 2) Branches Mullvad + cookies + URL (tue ~8 survivants `Conditional/Logical/Eq`)

*Tests à ajouter :*
* `MULLVAD_ENABLED=true` sans `MULLVAD_PROXY` → `args` contient `socks5h://127.0.0.1:1080`
* `MULLVAD_ENABLED=true` avec `MULLVAD_PROXY=socks5h://custom:1080` → contient custom
* `MULLVAD_ENABLED≠'true'` (absent / `'false'` / `'1'`) → ne contient pas `--proxy`
* `resolveYouTubeCookiesPath()` → stub qui retourne `null` vs `/tmp/cookies.txt` → vérifier présence/absence de `--cookies <path>`
* `job.url` en dernier arg → `args[args.length-1] === job.url`

On stub `shared/secrets.ts` via `import * as secrets from '../../src/shared/secrets.ts'` + monkey-patch, ou on pose un vrai fichier dans `jobDir` et on contrôle `fs.existsSync`.

**Commit 2 :** `test(download): cover Mullvad proxy and cookies branches`

### 3) Contexte `runProcess` (tue ~4 survivants `ObjectLiteral/StageError`)

* Vérifier que `runProcess` est appelé avec `{ stage:'downloading', timeoutMs: context.timeoutMs, logPath, onHeartbeat, signal }` — en spiant `runProcess` ou en faisant échouer le fake et en assertant `stage === 'downloading'` + `details` contient le log.

* Tester le cas `timeoutMs` custom et `signal` aborté (déjà couvert par `process-boundary` mais pas via `download`).

**Commit 3 :** `test(download): assert runProcess stage context`

### 4) Fichiers produits & erreurs (tue ~6 survivants `find`/`throw`)

* `readdirSync` trouve `audio.webm` mais ignore `audio.wav` et `random.txt` → poser 3 fichiers, vérifier que `audioPath` pointe bien sur `audio.webm` et pas `audio.wav`.
* `!audioFile` → fake qui n'écrit rien → `assert.rejects(..., stage==='downloading' && message==='YouTube audio was not downloaded.')`
* Titre : fichier `.title` absent → retourne `'Untitled YouTube video'` ; fichier avec `\r\n` multi-lignes + espaces → `trim().split(/\r?\n/).at(-1)` → dernier ligne trimmée ; titre >500 → `slice(0,500)`.

**Commit 4 :** `test(download): cover audio discovery and title edge cases`

### Critères d'acceptation

* `npx stryker run --mutate src/worker/stages/download.ts` → `≥ 80%` (objectif 90% comme `convert`), `0 survivant` sur les args critiques.
* `pnpm run test:integration` → 111 → ~118 tests, `mise run lint` vert, `git diff` ne touche que `tests/integration/convert-download-boundary.test.ts` + éventuel helper.
* Pas de changement prod (`src/worker/stages/download.ts` reste identique sauf si un mutant révèle un vrai bug — alors fix prod + test).

### Commandes

```bash
# benchmark avant
npx stryker run --mutate src/worker/stages/download.ts   # 45% attendu

# après chaque commit
pnpm run test:integration
npx stryker run --mutate src/worker/stages/download.ts   # viser 65% → 80% → 90%
mise run lint
```

### Risques & garde-fous

* `MULLVAD_ENABLED` touche `process.env` → restaurer `process.env` dans `afterEach`.
* `fs` réel sur temp dirs → `mkdtempSync` + `rmSync` déjà en place, ne pas muter le FS hôte.
* Ne pas bloquer le gate : `download.ts` reste en `mutation` manuelle (`mise run mutation -- --shared` ou per-file), pas dans `mise run test`.
