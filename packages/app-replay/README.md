# @fatos/app-replay — Niche Probe #2: Time-Travel Debugging / Replay

**Hypothesis:** Fatos is the *right engine* for tools whose primary job is state
history — visual flow/builders, low-code designers, undo-heavy editors, and
AI-agent session recorders. "Scrub any past state, diff any two states, undo
without destroying history" should be a data-model property, not app code.

## What it is

A browser-only "flow builder" (drag nodes, connect edges, rename, delete) whose
*real* subject is the fact log underneath:

- every user action is one append-only transaction,
- a timeline scrubber renders the board at any tx via `db.at(tx)`,
- a "this step" panel renders `db.diff(tx − 1, tx)` (adds/retracts),
- **Undo** replays the *inverse* of a step's diff — history is kept, so you can
  undo the undo,
- edges are stored as `ref()` facts between node entities,
- Export/import round-trips the full fact log through the core wire tags,
- the page publishes live snapshots to the Fatos DevTools panel
  (`installSnapshotPublisher`).

## How to run

> Full build/run/troubleshooting details (ports, `?server=`, env vars, stale
> data reset) are in [docs/running-demo-apps.md](../../docs/running-demo-apps.md).

```bash
npm run build --workspace @fatos/app-replay
npm run client --workspace @fatos/app-replay
# → open http://localhost:4175
```

Try: add a few nodes, connect them, drag one — then scrub the timeline back,
hit Undo a few times, export, and re-import the JSON into a fresh tab. With the
Fatos DevTools extension installed, the Facts/Timeline/Diff tabs follow along.

## What it exercises

| Fatos feature | Where in the app |
|---|---|
| `db.at(tx)` — reconstruct any past state | `readBoardAt` / the scrubber |
| `db.diff(txA, txB)` — step deltas | "This step (diff)" panel + undo inverse |
| `ref()` values (graph edges) | `addEdge`, `refTarget` |
| `db.set` retract+add updates | move / rename (`board.ts`) |
| Append-only undo (inverse-of-diff, history preserved) | `buildInverse` + `apply` |
| Snapshot export/import (`serializeValue`/`deserializeValue`/`restore`) | `exportSnapshot` / `importSnapshot` |
| DevTools bridge | `installSnapshotPublisher(client)` |
| Live client events | `useClientTick` re-renders the board |

The logic is unit-tested in `src/board.test.ts` (6 tests: at-tx reads, ref
round-trips, inverse undo, cascade delete, snapshot round-trip).

## Verdict

**Fit: strong, and the most *differentiated* niche.** This is the closest any of
the three probes comes to a capability that is *hard to build without* a
temporal store. Undo-with-history, per-step diff, and scrub-to-any-point took
~200 lines of demo code because `at`/`diff`/`ref` already existed in the engine.
A comparable app on a normal database needs an event-sourcing layer first.

**Friction observed:**
- `entity()` returns `ref()` values as branded objects, not plain ids — reading
  an edge means `refTarget(value)` unwrapping. The design docs promise plain-id
  by default; that flag is not implemented yet (P4).
- The undo wrapper had to *compute* the diff after a write to build its inverse
  (there is no "what did the last tx do" sugar beyond `diff`). Fine, but a
  `db/txMeta` convenience would help.
- Restoring a snapshot replaces the whole client instance, so React context
  must re-provide it (we handle it with `onReplace`). Acceptable, but worth
  documenting as a pattern.

**Bottom line:** this is Fatos's *moat*. DevTools + time-travel + undo is a
product pitch ("your app, replayable and inspectable") that no general-purpose
database markets directly.

> Note: this niche overlaps with the existing DevTools/schema-designer packages
> — a flow-builder product and the DevTools extension would be natural
> companions, not competitors.
