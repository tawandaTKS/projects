# Private Analyst: a private AI data analyst

Drop in CSV, Excel or Parquet files and ask questions in plain English. You get a written answer, a chart, a table and the exact SQL behind it. **Your data never leaves your computer.** Queries run in [DuckDB](https://duckdb.org) and the AI model runs locally in [Ollama](https://ollama.com).

It's built for teams that aren't allowed to paste data into ChatGPT: accountants, clinics, HR and finance staff.

| | Desktop (Windows, macOS, Linux) | Mobile (iOS, Android) |
|---|---|---|
| Shell | Electron | Capacitor |
| Query engine | Native DuckDB (`@duckdb/node-api`), saved to a local workspace file | DuckDB-WASM inside the app, in memory only |
| AI model | Ollama on the same computer (`127.0.0.1:11434`) | Ollama on the user's own computer over Wi-Fi |
| File types | CSV/TSV, Excel (.xlsx), Parquet, JSON/NDJSON | Same |
| UI | Shared React app (`packages/ui`) | Same code, responsive layout |

## How a question is answered

```
question ─▶ schema profile (types, ranges, category values, 3 sample rows)
         ─▶ local model writes DuckDB SQL (structured JSON output)
         ─▶ read-only guard ─▶ DuckDB runs it on-device
              │  error? → the error goes back to the model, which fixes the query (up to 3 tries)
         ─▶ chart picked & validated against the result
         ─▶ local model explains the result in 1–3 sentences
```

Follow-up questions ("now split that by month") work because earlier questions and their SQL are sent along as context.

## Privacy and security model

The privacy promise is enforced in code at each layer. It is not just a policy.

- **No cloud calls.** The desktop renderer has a CSP of `connect-src 'none'`, and Electron cancels every HTTP/WebSocket request the page makes (`lockDownNetwork` in `apps/desktop/src/main/main.ts`). The only outbound connection is the main process calling the Ollama address the user set.
- **The model server must be private.** The Ollama URL has to be loopback or a private LAN range (`packages/core/src/network.ts`). Using any other server needs an explicit opt-in setting.
- **DuckDB never downloads code.** Extension auto-install and auto-load are off, and the configuration is locked (`SET lock_configuration = true`). On mobile, Parquet is decoded in JavaScript ([hyparquet](https://github.com/hyparam/hyparquet)) so DuckDB-WASM never needs to fetch its parquet extension.
- **AI-written SQL is untrusted.** Two layers check it:
  1. A lexical guard, used on both platforms (`packages/core/src/sqlGuard.ts`). It allows exactly one `SELECT`/`WITH` statement. It blocks file and URL readers (`read_csv`, `glob`, `query()`…), string literals or quoted names that look like paths or URLs, and all write/DDL/`ATTACH`/`COPY`/`PRAGMA`/`SET` statements.
  2. On desktop, an allow-list check on DuckDB's own parse tree (`json_serialize_sql`). Every table referenced must be one the user imported, or a CTE. This blocks `information_schema`, `duckdb_settings()`, the internal catalogue, and files named directly as tables.
- **Nothing is left behind by imports.** Excel is converted to CSV in a private temp folder that is deleted straight away. Original files are never modified.
- **Auditable.** Every answer shows its SQL, and you can copy it or export the result.
- Encryption at rest: DuckDB's encrypted databases currently need the `httpfs` extension, which is a network component, so we rely on OS disk encryption (BitLocker/FileVault) instead. Say so in sales material for clinics.

## Getting started (development)

Requires Node 22+.

```bash
npm install
npm test                    # unit + integration tests (real DuckDB, real files)
npm run dev:desktop         # Electron + Vite with hot reload
npm run dev:mobile          # mobile UI in a browser at http://localhost:5174
```

For real answers, install Ollama and pull a model:

```bash
ollama pull qwen2.5-coder:7b      # recommended: strong SQL, runs on 16 GB laptops
# smaller machines: qwen2.5-coder:3b   ·  best accuracy: qwen2.5-coder:14b
```

The app picks an installed model automatically, and you can change it in Settings. When you test the mobile UI in a desktop browser, start Ollama with `OLLAMA_ORIGINS=*` so the browser can reach it. Real devices use native HTTP, so they don't need this.

### End-to-end tests

```bash
npm run test:e2e:desktop    # launches the built Electron app against a mock Ollama (needs xvfb on Linux)
npm run test:e2e:mobile     # mobile bundle in a phone-sized Chromium: imports CSV/Excel/Parquet, asks a question
```

## Shipping

### Desktop installers

```bash
npm run license:keygen      # once: creates your signing key and embeds the public key
npm run dist:desktop        # → apps/desktop/release/ (dmg/zip, NSIS .exe, AppImage/deb)
```

- Build each OS on that OS (CI runners for macOS, Windows and Linux). DuckDB ships a prebuilt N-API binary per platform, and N-API is ABI-stable, so there's no rebuild for Electron.
- Sign and notarize: set the usual `electron-builder` variables (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
- `dist:desktop` refuses to build without a licence public key, so you can't ship a build with licensing turned off by mistake.
- `PADA_BUILD_DATE=YYYY-MM-DD` pins the release date that update entitlements are checked against. By default it is today.

### Mobile apps

```bash
cd apps/mobile
npx cap add android && npx cap add ios     # once
npm run patch-native                       # allow HTTP to Ollama on the LAN (Android NSC, iOS local networking)
npm run android    # or: npm run ios        # build, sync, open in Android Studio / Xcode
```

Phones can't run a capable SQL model well, so on mobile the app connects to Ollama on the user's own computer. On that computer, start it with `OLLAMA_HOST=0.0.0.0 ollama serve` and enter its address (e.g. `http://192.168.1.20:11434`) in Settings. Files and query results stay on the phone. Only the question, the schema summary and (optionally) three sample rows go to the user's own machine. Mobile workspaces are in memory and are cleared when the app closes.

## Licensing and business model

**One-time licence plus paid updates**, the same "perpetual fallback" model JetBrains and Sketch use:

- A key unlocks **every version released before its `updatesUntil` date, forever**. Newer versions need a renewal. Customers who don't renew keep using their last covered version.
- Keys are Ed25519-signed and **checked fully offline**, so there's no activation server and no phone-home. That matters for this audience.
- There is a 14-day full-featured trial. When it ends, past results stay visible, but asking new questions needs a key.

Issue keys yourself, or from your store's order webhook (Stripe, Paddle, Lemon Squeezy, Gumroad):

```bash
npm run license:issue -- --name "Acme Clinic" --email ops@acme.com --edition pro --seats 3 --months 12
```

Keep `tools/license/.keys/private.key` secret and backed up. It is git-ignored. If you lose it you can't issue keys that existing installs accept.

Suggested pricing to test:

| Edition | Price | Includes |
|---|---|---|
| Standard | $149 one-time | 1 seat, 12 months of updates |
| Pro | $249 one-time | 2 devices (desktop + mobile), 12 months of updates, priority email support |
| Team | $199 per seat (5+) | Volume key, deployment guide, IT-friendly MSI/PKG |
| Update renewal | 40% of the current price per year | Another 12 months of new versions |

App Store note: Apple generally requires in-app purchase (StoreKit) to unlock features in iOS apps, and Google Play requires Play Billing. Plan a store purchase for the mobile unlock, or sell desktop and mobile separately. The licence-key unlock is fine for direct desktop sales. Check the current store guidelines before you submit.

## Repository layout

```
packages/core     Shared logic: SQL guard, schema profiling, prompts, Ollama client,
                  ask/repair loop, chart selection, Excel→CSV, licence verification
packages/ui       Shared React UI (chat, charts, tables, settings, licence dialogs)
apps/desktop      Electron main (native DuckDB, IPC, network lockdown), preload, renderer
apps/mobile       Capacitor app: DuckDB-WASM engine, native-HTTP Ollama client
tools/license     Vendor key generation and licence issuing
tests             Vitest unit/integration tests and Playwright e2e tests (mock Ollama)
```

## Known limitations and roadmap

- `.xls` (pre-2007 Excel) isn't supported. Users can re-save as `.xlsx` or CSV.
- Very large Excel files are parsed in memory. Very large CSV and Parquet files are fine because DuckDB streams them.
- Ideas: saved reports and dashboards, scheduled re-runs on refreshed files, PDF export, an on-device model for mobile (llama.cpp) once small models write reliable SQL, and an MDM-deployable config for IT teams.
