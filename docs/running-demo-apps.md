# Running the Fatos Demo Apps

Three small runnable apps, one per candidate niche (see
[niche-validation.md](./niche-validation.md) for why each exists and what it
found):

| App | Package | Niche probe | Server? | Client port | Server port |
|---|---|---|---|---|---|
| **Ops Desk** | `@fatos/app-ops-desk` | Audit/operations (fulfillment + inventory, time travel) | ✅ required | `4174` | `4100` |
| **Replay** | `@fatos/app-replay` | Time-travel debugging (flow builder, scrub/diff/undo) | ❌ browser-only | `4175` | — |
| **LiveBoard** | `@fatos/app-liveboard` | Realtime collaboration (multi-client kanban) | ✅ required | `4176` | `4200` |
| **FieldSync** *(planned)* | `@fatos/app-fieldsync` | Device/edge state sync (caches, reboot-resume, "facts since a date") | ✅ required | `4177` | `4300` |

FieldSync is designed but not yet built — see
[docs/app-fieldsync-design.md](./app-fieldsync-design.md) for its full build
specification (schema, package layout, durable-mirror helpers, milestones, and
which library gaps it depends on).

The full-stack apps (Ops Desk, LiveBoard) follow the same two-terminal shape:
a `FatosServer` with file persistence, and an esbuild-served browser client
that connects over WebSocket. Replay is entirely client-side.

## Prerequisites

- Node.js **18+** and npm 9+ (workspaces support).
- A one-time root install + build so the `@fatos/*` workspace packages have
  their `dist/` outputs (cross-package imports resolve through `dist/`, not
  `src/`):

```bash
npm install
npm run build          # builds every workspace package, including the apps
```

## Run Ops Desk (audit/operations)

```bash
# terminal 1 — the Fatos server (seeds ./data on first run; persists everything)
npm run server --workspace @fatos/app-ops-desk

# terminal 2 — the browser client
npm run client --workspace @fatos/app-ops-desk
# → open http://localhost:4174
```

**Try:** adjust stock (+/−), advance an order (`placed → picked → shipped →
delivered`), watch the Audit panel grow, then drag the **Time travel** slider
back — the dashboard flips to the exact state at that transaction. Restart the
server: stock levels and the audit trail survive (`./data/ops-desk.json` +
append log).

## Run Replay (time-travel debugging)

```bash
# no server needed — one command, then open the browser
npm run client --workspace @fatos/app-replay
# → open http://localhost:4175
```

**Try:** add nodes, connect them (`from…` / `to…`), drag a node, rename, delete.
Then scrub the **Timeline** slider to any point, watch **This step (diff)** show
the adds/retracts of that transaction, hit **Undo** a few times (history is
kept — you can undo the undo), and **Export** / re-**Import** the JSON in a
fresh tab. With the Fatos DevTools extension installed, the panel's
Facts/Timeline/Diff tabs follow the board live.

## Run LiveBoard (realtime collaboration)

```bash
# terminal 1 — the Fatos server
npm run server --workspace @fatos/app-liveboard

# terminal 2 — the browser client
npm run client --workspace @fatos/app-liveboard
# → open http://localhost:4176 in TWO tabs
```

**Try:** drag a card between columns in one tab and watch it move in the other;
add a card and see it appear everywhere. The **Transaction log** panel shows
every drag with its actor metadata.

## Configuration

| Setting | How |
|---|---|
| Client → server address | `?server=ws://host:port/ws` query param (defaults to `localhost` on the app's port) |
| Server port | `PORT=…` env var (e.g. `PORT=5000 npm run server --workspace @fatos/app-ops-desk`) |
| Server bind host | `HOST=…` env var (default `127.0.0.1`) |
| Persistence file | `<package>/data/<app>.json` (+ `.log` append file); delete the `data/` dir to reset the demo |

Note: the client address and the server `PORT` must agree — the browser page
derives its REST base URL from the WebSocket URL.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Build fails on `@fatos/*` imports | Build the workspace deps first: `npm run build` at the repo root |
| `listen EADDRINUSE` | Another instance is running — stop it (`lsof -ti tcp:4100 \| xargs kill`) or set a different `PORT` + matching `?server=` |
| Page stuck on "Connecting to ws://…" | The server isn't running or the port/address is wrong; check terminal 1 |
| Demo shows stale data | Stop the server, delete `<package>/data/`, restart (re-seeds) |
| `static/app.js` missing / 404 | The `client` script bundles it automatically at serve start — wait a second and reload; if it truly never appears, run `npm run build --workspace @fatos/app-…` |
| Replay: DevTools panel says "waiting for snapshot" | Install the Fatos DevTools extension and hard-reload; the page publishes snapshots on every write |

## What each app maps to (quick reference)

| App | Exercises |
|---|---|
| Ops Desk | Schema-as-facts + `unique: 'identity'`, transaction metadata as audit trail, `client.find(criteria, tx)` time travel, syncing client + live `useQuery`, `FileAdapter` persistence/restart recovery, REST `POST /transact` |
| Replay | `db.at(tx)`, `db.diff(txA, txB)`, diff-inverse undo, `ref()` values, `db.set` updates, snapshot export/import, DevTools publisher bridge |
| LiveBoard | WebSocket live mirror with `afterTx` catch-up, per-column live queries, server-authoritative REST writes + broadcast replay |

See each package's README (`packages/app-*/README.md`) for the niche verdict
and the friction points the apps surfaced.
