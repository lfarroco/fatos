# App Design — FieldSync (device / edge state sync demo)

> **Status: design — not yet built** (deferred 2026-08-16; see
> [niche-validation.md](./niche-validation.md) "Follow-ups").
>
> This is the build specification for the fourth demo app. It validates the
> fact-log sync thesis:
>
> > Fatos is a server-authoritative fact log where every local cache is a
> > replayable slice of the same log — read locally, catch up incrementally,
> > rebuild from any point.
>
> It depends on the library gaps tracked in [niche-gap-tasks.md](./niche-gap-tasks.md)
> (G3, G4, G8, G9, G10) — each marked below as **required** vs **gracefully
> degradable**.

## 1. Purpose — what the demo must prove

1. **Reboot-resume.** A device with a durable local cache (IndexedDB) restarts,
   reconnects, and downloads only the facts since its last watermark — not a
   full pull. UI shows: "resumed at tx 87 · downloaded 12 facts / 4
   transactions since last boot".
2. **"New facts since `<date>`".** The device asks "what changed since
   2026-01-01" and gets exactly the delta — a temporal catch-up query, not an
   opaque tx id.
3. **Relay.** A heartbeat written in the Device tab appears live in the HQ tab
   (two browser windows, one server), and the HQ tab can reconstruct any
   device's history at any point (`at(tx)`).

## 2. Topology & ports

```
Device tab ──ws──┐                          ┌──ws── HQ dashboard tab
(IndexedDB cache)│   POST /transact (REST)  │   (in-memory mirror)
                 └──▶ FatosServer ◀─────────┘
                     (FileAdapter,
                      tx authority / relay)
```

| Setting | Value |
|---|---|
| Package | `@fatos/app-fieldsync` |
| Server port | `4300` (env `PORT`) |
| Client port | `4177` (esbuild serve) |
| Pages | `http://localhost:4177/device.html` · `/hq.html` |
| Persistence | `<package>/data/fieldsync.json` (+ append log) |
| Device cache | `IndexedDBAdapter` under `databaseName: 'fatos-fieldsync'` |

## 3. Data model (schema, declared in `seed.ts`)

| Attribute | Type | Cardinality | Notes |
|---|---|---|---|
| `device/id` | string | one, `unique: 'identity'` | e.g. `kiosk-01` |
| `device/name` | string | one | |
| `device/status` | string | one | `online` \| `offline` \| `error` \| `charging` |
| `device/battery` | number | one | 0–100 |
| `device/lastSeen` | date | one | crosses the wire as `{ $date: ms }` (design/03 tag) |
| `device/room` | string | one | location label |
| `device/version` | string | one | software version |

Seed 3 devices (`kiosk-01…03`) in one transaction (idempotent — seed only when
`server.query({ find: ['?e'], where: [['?e', 'device/id', '?id']] })` is empty).

## 4. Package layout

```
packages/app-fieldsync/
  package.json            # scripts below
  tsconfig.json           # extends ../../tsconfig.json, jsx react-jsx
  .gitignore              # dist/ data/ static/*.js
  static/device.html      # entry: /device.js
  static/hq.html          # entry: /hq.js
  static/style.css
  src/
    server.ts             # FatosServer + FileAdapter + SIGTERM/SIGINT flush; seeds
    seed.ts               # schema + 3 devices (idempotent)
    api.ts                # postTransact(baseUrl, entries, metadata) — same shape as the other demos
    syncCache.ts          # durable-mirror helpers (see §6) — the core module
    app.tsx               # DeviceApp + HqApp components (shared UI pieces)
    device.tsx            # entry for device.html: mounts DeviceApp
    hq.tsx                # entry for hq.html: mounts HqApp
    syncCache.test.ts     # unit tests for syncCache.ts
```

## 6. The durable mirror (`src/syncCache.ts`) — the core of the app

Three helpers, all buildable with today's public API:

```ts
// 1. Load the cache into a client, ready to resume.
async function loadMirror(adapter: StorageAdapter): Promise<{ client: FatosClient; watermark: number | null }>
//   snapshot = await adapter.load(); db = createDatabase(); db.restore(snapshot);
//   client = new FatosClient(db); watermark = lastAppliedTx(snapshot);

// 2. Persist every applied transaction into the cache (durable mirror).
function persistMirror(adapter: StorageAdapter, client: FatosClient): () => void
//   client.addEventListener(TRANSACTION_COMMITTED_EVENT, (e) => {
//     void adapter.append(e.transaction, e.facts);      // O(tx size) append
//   });

// 3. "Facts since <date>" — map wall-clock time to a tx id (temporal catch-up).
function txAtOrBefore(transactions: readonly TransactionRecord[], timestamp: number): number
//   binary search for the last tx with ts <= timestamp; 0 when none.
//   (G4/G9 would promote this to a core helper / wire `afterTime`.)
```

### Resume path

- **Preferred (after G8 lands):** `loadMirror(adapter)` → pass the restored
  client to `createSyncingClient({ url, client })`. G8 derives the initial
  `afterTx` watermark from that client's ledger head, so the first connect is a
  delta, not a full pull.
- **Today (graceful workaround):** `createSyncingClient` always full-pulls when
  handed a client (it does not read the ledger). Two options:
  - *Accept the full pull* for M2 and show cache stats ("would resume at tx 87;
    re-pulled 3 items because G8 isn't landed").
  - *Drive the protocol directly* with the exported low-level helpers
    (`parseSyncMessage`, `applyDeltaToClient`, `catchUpDelta`, `lastAppliedTx`,
    `maxTxOf`) over a raw `WebSocket` — the `sync` message accepts `afterTx`, so
    a ~100-line `deviceSync.ts` module can perform the incremental catch-up
    itself and then hand live `sync-event`s to `applyDeltaToClient`. This is the
    cleanest *proof* of the thesis before G8 lands, and it is exactly the
    duplicated logic that G8/G10 should absorb into `createSyncingClient`.

### Reboot

The Reboot button: `sync.stop()` → drop the in-memory db/client → `loadMirror`
again → reconnect. Everything needed for a durable local cache already exists:
`IndexedDBAdapter.load/save/append` + `db.restore` + the sync protocol.

## 7. Device panel (`DeviceApp`)

- **Cache stats:** facts cached, watermark tx, last sync time, cache size.
- **Heartbeat:** button + optional auto-tick (every 5 s) that writes `status`,
  `lastSeen` (a `Date` → `{ $date: … }` on the wire), and a random `battery`
  wobble via `postTransact` retract+add pairs with metadata
  `{ actor: 'device:<id>', action: 'heartbeat' }`.
- **Reboot:** as above; the status line shows the delta counts.
- **"Catch up since `<date>`":** a `<input type="datetime-local">`; the app
  computes `afterTx = txAtOrBefore(localLedger, date)` and shows exactly the
  facts/transactions committed since (filtering `client.getFacts()` by
  `f[3] > afterTx`). If `afterTime` (G9) lands, a "ask the server" button
  reconnects with `afterTime` instead.

## 8. HQ dashboard (`HqApp`)

- Plain in-memory `createSyncingClient` (no cache) — the relay witness.
- **Fleet table** (live via `useQuery`): id, name, room, status, battery,
  lastSeen, version — re-renders only on relevant writes.
- **Transaction log**: shared ledger with `actor`/`action` metadata.
- **Device timeline**: select a device; a scrubber over txs renders
  `client.entity(eid, tx)` (or `client.atTransaction(tx).entity(eid)`) — "what
  was the battery at tx N". (Reuses the Ops Desk time-travel panel pattern.)


## 5. Server (`src/server.ts`)

Mirror the Ops Desk server exactly (CJS bundle for `ws`, `main()` wrapper,
graceful shutdown, `FileAdapter` at `data/fieldsync.json`, seed-if-empty):
`npm run server` from the package dir. No new server features are needed to run
the demo; the server is purely the tx authority + relay.

## 9. Scripts (`package.json`)

```jsonc
"scripts": {
  "build":  "esbuild src/server.ts --bundle --platform=node --format=cjs --outfile=dist/server.cjs && esbuild src/device.tsx src/hq.tsx --bundle --format=esm --jsx=automatic --outdir=static --outbase=src",
  "server": "node dist/server.cjs",
  "client": "esbuild src/device.tsx src/hq.tsx --bundle --format=esm --jsx=automatic --outdir=static --outbase=src --servedir=static --serve=4177",
  "types":  "tsc --noEmit",
  "lint":   "eslint src",
  "test":   "vitest"
}
```

Dependencies: `@fatos/client`, `@fatos/core`, `@fatos/persistence`,
`@fatos/react`, `@fatos/server`, `react`, `react-dom`; devDeps `@types/node`,
`@types/react`, `@types/react-dom`, `esbuild`, `typescript`, `vitest`.

## 10. Tests & validation

- **Unit (`syncCache.test.ts`):** `loadMirror`/`persistMirror` round-trip with a
  fake in-memory adapter; `txAtOrBefore` returns the right boundary (before
  first tx → 0, between txs, after head → head).
- **Server smoke:** seed → heartbeat via `POST /transact` (with a `{ $date }`
  value) → `GET /facts` / `GET /transactions` reflect it → restart recovers.
- **Manual script (the acceptance criteria):**
  1. Open `device.html` + `hq.html`. Heartbeat → appears in HQ within ~1 s.
  2. Reboot the device → status line shows a small delta ("resumed at tx N ·
     downloaded M facts"), not a full re-pull.
  3. Pick a `<date>` → the delta list equals facts with `tx > txAtOrBefore(date)`.
  4. After a reboot, the device panel renders instantly from IndexedDB even
     while the socket is still reconnecting (offline read).
  5. HQ timeline scrub reconstructs a device's battery at an earlier tx.

## 11. Milestones

- **M1** — server + seed + `HqApp` (in-memory sync). Proves relay + live reads.
- **M2** — `syncCache.ts` + `DeviceApp` cache stats + Reboot (full-pull
  workaround or the raw-protocol module). Proves the durable mirror.
- **M3** — "facts since `<date>`" control (`txAtOrBefore` app-side). Proves
  temporal catch-up.
- **M4** — device timeline scrub in HQ + verdict README + link updates. Writes
  up what felt natural/awkward, like the other three apps.

## 12. Library-gap dependency matrix

| Gap | Role in this app | Requirement |
|---|---|---|
| **G3** (write-through on `SyncingClient`) | Drop the local `postTransact` helper | Optional (app uses `api.ts` like the other demos) |
| **G4** (core `txAtOrBefore`) | Promote `syncCache.txAtOrBefore` to a library helper | Nice-to-have (app-side binary search works today) |
| **G8** (derive watermark from passed client) | Clean incremental resume on Reboot | **Required** for the clean demo; raw-protocol module is the workaround |
| **G9** (`afterTime` on sync message / REST) | "Ask the server for facts since `<date>`" | Optional (app-side mapping + `afterTx` suffices for the UI) |
| **G10** (persist-mirror option on `createSyncingClient`) | Replace `persistMirror` with a library option | Nice-to-have (app-side `persistMirror` is ~20 lines today) |

Recommended order: build the app alongside **G8** (and ideally **G10**), which
turns the Reboot milestone from a workaround into the actual product shape.

