# Design — Networked game example (two-player tic-tac-toe over the fact log)

> **Status: design — not yet built.**
>
> Build spec for a small, runnable **networked game** example. It recombines
> capabilities the codebase already has — `createSyncingClient` (live mirror),
> `FatosServer` (tx authority + relay), `at(tx)`/`diff` (time travel) — into the
> most relatable demo the project ships: two players playing a turn-based game
> against one shared, server-authoritative fact log.
>
> This is a *showcase*, not a fourth niche probe. `app-replay` already owns the
> temporal moat; this example re-packages it with a game's mass appeal and
> foregrounds the **Datalog query** side, which the three niche apps under-use.

## 1. Purpose — what the example must prove

1. **A move is a transaction.** Each `cell/owner` write is one atomic
   transaction whose metadata (`{ player, move, action }`) *is* the move list /
   audit trail.
2. **Live sync without polling.** Two `createSyncingClient` mirrors converge:
   player X's move appears on player O's mirror via the server's
   `transaction:committed` broadcast.
3. **Time travel is free.** Reconstruct the board at any move with `at(tx)`,
   diff any two moves, and undo = replay the inverse of a diff (history kept,
   not erased).
4. **Datalog reads the board.** "Cells owned by X", "is this cell taken", and
   win detection are `find`/`where` queries, not bespoke state scans.

## 2. Locked decisions (defaults)

| Decision | Choice |
|---|---|
| Game | Tic-tac-toe (Connect 4 = follow-up if relational win-detection is wanted) |
| Delivery shape | **Shape A: headless example in `@fatos/examples`** (a `run()` + vitest). Shape B (browser app) is M4 |
| Player identity | Fixed X/O per client (no lobby / seat selection) |
| Turn enforcement | Client-side, via a shared pure `game-rules.ts`; server-side validation flagged as a gap (§9) |
| Spectator / late-join | Deferred (M3) |

## 3. Topology

```
                 FatosServer (in-memory, ephemeral port; single source of truth)
               ┌──────────────────────────────────────────────────────┐
 player X  ───►│  sync.transact → POST /transact (REST write-through) │
 (mirror)      │  WS /ws: snapshot → sync-event (transaction:committed)│◄─── player O (mirror)
               └──────────────────────────────────────────────────────┘
```

| Setting | Value |
|---|---|
| Package | `@fatos/examples` (new files `src/networked-game.ts` + `src/game-rules.ts`) |
| Server | `createFatosServer()` in-memory, `start({ port: 0 })` (ephemeral) |
| Clients | two `createSyncingClient({ url, createSocket, onStatusChange })` |
| WS URL | `ws://<host>:<port>/ws` |
| Socket impl | `ws` package — the examples runtime has no global `WebSocket`, so pass `createSocket: () => new WebSocket(url) as unknown as SyncSocket` (same import `full-stack-app.ts` uses) |

## 4. Data model (schema-as-data, seeded from `game-rules.ts`)

| Attribute | Type | Cardinality | Meaning |
|---|---|---|---|
| `cell/row` | number | one | 0–2 |
| `cell/col` | number | one | 0–2 |
| `cell/owner` | string | one | `'x'` \| `'o'` |
| `game/next` | string | one | whose turn (`'x'` \| `'o'`) |
| `game/status` | string | one | `'playing'` \| `'x-won'` \| `'o-won'` \| `'draw'` |

- Each **cell is an entity** (`cell/row` + `cell/col` + `cell/owner`), so "all X
  cells" is a one-clause query and win detection is a join over owned cells.
- **One move = one transaction**: `['add', cellId, 'cell/owner', player]` +
  retract/add `game/next` (+ set `game/status` on a terminal move). Atomicity
  means the other player can never observe a half-move.
- `cellId` is deterministic: `cell-${row}-${col}` (stable string eids).

## 5. `game-rules.ts` — the pure, engine-agnostic rules module

The one design decision worth calling out: **rules live outside the engine, in
a pure module both the example (now) and a future server hook (later) can
call.** It imports nothing environment-specific and takes a `FatosClient`/db as
an argument rather than owning one.

Exports:

- `SEED_ENTRIES: TransactionEntry[]` — schema declarations, same shape as
  `app-liveboard`'s `seed.ts`.
- `readBoard(client, tx?)` → `('x'|'o'|null)[][]` — from
  `find({ 'cell/owner': { $exists: true } })`, or `at(tx)` for a past board.
- `cellsOwnedBy(client, player)` → eids — Datalog `find`/`where` on `cell/owner`.
- `isCellTaken(board, row, col)`.
- `winner(board)` → `'x' | 'o' | 'draw' | null` — 8 lines, plus a draw check.
- `moveEntries(row, col, player)` → `Mutation[]` — the add + `game/next`
  retract/add (+ `game/status` when terminal).
- `playMove(client, player, row, col)` → `Promise<WriteResult>` — validates
  (correct turn, empty cell, game not over), then
  `client.transact(moveEntries(...), { player, action: 'move', move: n })`;
  throws on an illegal move.

## 6. Example file plan + wiring

New files:

- `packages/examples/src/game-rules.ts` — the rules module (§5).
- `packages/examples/src/networked-game.ts` — `run(): Promise<NetworkedGameResult>`.

Wiring (the five touchpoints every example hits):

- `src/index.ts` — import + call in `runAll()`.
- `src/cli.ts` — import + `'networked-game': run` map entry.
- `package.json` — `"example:networked-game": "vite-node src/cli.ts networked-game"`.
- `README.md` — table row + script line.
- `src/index.test.ts` — behavior assertions (§8).

## 7. `run()` flow (the acceptance script)

1. Start `FatosServer` on `port: 0`; derive `wsUrl`.
2. `server.transact(SEED_ENTRIES, { source: 'seed' })` — schema plus initial
   `game/next: 'x'`, `game/status: 'playing'`.
3. Create `playerX` / `playerO` syncing clients; `start()` both; `waitFor`
   both `getStatus() === 'synced'`.
4. Scripted game, alternating `playMove(playerX|O, …)`. After each move,
   `waitFor` the *other* mirror to show the cell (proves live sync, no polling).
5. On the winning move, assert both mirrors report the same `game/status`.
6. Replay: for each tx, render the `atTransaction(tx)` board — an ASCII board
   per move.
7. Undo: `buildInverse(diff(head − 1, head))` → `playerX.transact(inverse,
   { action: 'undo' })`; assert the board is one move back and the log is
   *longer* (history preserved).
8. Return `{ moves, boardsAtTx, winner, finalBoard, txCount }`; `server.stop()`.

## 8. Tests

- `game-rules` unit tests (pure, no server): win/lose/draw, turn validation,
  occupied-cell rejection, `moveEntries` shape.
- `networked-game` integration test (vitest, one-shot): both mirrors converge
  after each move; the ledger equals the move list; `at(tx)` board matches the
  expected intermediate state; undo restores the prior board while the log
  grows.

## 9. Gap / friction notes (record these in the example's README, like the niche apps do)

- **The server does not enforce game rules.** `FatosServer` is a generic fact
  store — nothing stops a client from writing `cell/owner` out of turn. The
  example validates client-side via `game-rules.ts`. A server-side hook (custom
  validation / middleware on `/transact`) does not exist yet; flag it as a
  future library gap.
- **Undo is computed, not provided.** There is no "what did the last tx do"
  sugar; the example calls `diff(head − 1, head)` and inverts it (the same
  friction `app-replay` already documented).

## 10. Milestones

- **M1** — `game-rules.ts` + unit tests. Pure rules, no network.
- **M2** — `networked-game.ts` headless example + wiring + integration test.
  The whole pitch runs in one command and is verified by vitest.
- **M3** — *(optional)* spectator / late-join: a third client connects
  mid-game, catches up via the snapshot pull, and shows the full move history.
- **M4** — *(optional, Shape B)* browser app `@fatos/app-tic-tac-toe` (React
  board via `useSyncedClient` + `FatosProvider`, mirroring `app-liveboard`),
  registered in `running-demo-apps.md` + the root README.

