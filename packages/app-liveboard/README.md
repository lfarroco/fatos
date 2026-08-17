# @fatos/app-liveboard — Niche Probe #3: Realtime Multi-Client Boards

**Hypothesis:** Fatos can serve *realtime collaborative boards/dashboards*
(kanban, ops dashboards, live inventory). This is intentionally the *weakest*
fit of the three — any realtime datastore can power a kanban — so the probe asks
a sharper question: does the temporal core still add value once the realtime
plumbing exists?

## What it is

A collaborative kanban board over one `FatosServer`:

- three columns; cards have `card/title`, `card/column`, `card/order` facts,
- HTML5 drag-and-drop moves a card (retract+add of column + order in one tx),
- every connected tab mirrors the server over WebSocket (`createSyncingClient`),
  and each column subscribes to its own slice via `useQuery`,
- an activity panel renders the shared transaction log with actor metadata,
- file persistence (`FileAdapter`), so the board survives restarts.

## How to run

> Full build/run/troubleshooting details (ports, `?server=`, env vars, stale
> data reset) are in [docs/running-demo-apps.md](../../docs/running-demo-apps.md).

```bash
npm run build --workspace @fatos/app-liveboard

# terminal 1: the Fatos server
npm run server --workspace @fatos/app-liveboard

# terminal 2: the browser client
npm run client --workspace @fatos/app-liveboard
# → open http://localhost:4176 in TWO tabs and drag cards between them
```

## What it exercises

| Fatos feature | Where in the app |
|---|---|
| WebSocket live mirror with `afterTx` catch-up | `useSyncedClient` (both tabs) |
| Live queries, narrowed per column | `ColumnContainer` → `useQuery` |
| REST writes + broadcast + replay on each client | drop handler → `postTransact` |
| Server-authoritative writes (mirror is read-only) | `src/api.ts` |
| Transaction metadata for activity | every write carries `{ actor, action, … }` |
| `FileAdapter` persistence | restart recovery |

## Verdict

**Fit: decent, but not differentiating on its own.** The realtime story works —
two tabs stayed in sync through live broadcasts, and the per-column live queries
re-rendered only what changed. But any of Firestore, Supabase, or a plain
WebSocket + state store would carry the demo. The temporal layer earns its keep
only in the places the other probes already claimed:

- the **activity log is the transaction log** (audit win, see Ops Desk),
- **"as of" debugging** of a live collaborative session (replay win),
- the board state is a *queryable projection* of a log, so "why did this card
  move here" is answered by facts, not archaeology.

**Friction observed:**
- **Ordering is application logic.** `card/order` is just a number; the column
  sorts in JS because the client `find` has no `orderBy` (core `find` supports
  it — the client wrapper doesn't expose options yet). Minor, but it means a
  real kanban needs its own reorder protocol on top.
- **Concurrent moves can collide.** Two tabs dropping into the same column
  compute orders from local state; the server doesn't resolve ordering
  conflicts (a documented non-goal — no CRDT/multi-writer).
- **Writes are REST, not WS.** The mirror applies broadcasts but can't send
  them, so the write path doesn't use the same channel as the read path.

**Bottom line:** don't position Fatos as "a realtime database." Position it as
*the temporal layer that realtime boards quietly benefit from* — same message
as the other two probes, with the realtime demo as proof the reactivity
foundation is solid.
