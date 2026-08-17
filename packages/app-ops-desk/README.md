# @fatos/app-ops-desk — Niche Probe #1: Audit-Heavy Operations

**Hypothesis:** Fatos is a strong fit for *line-of-business operations apps* where
every record is a state machine and "who changed what, when, and why" is a core
requirement — order fulfillment, inventory, ticketing, approvals, field service.

## What it is

An order-fulfillment + inventory tracker:

- a catalog of SKUs (`item/sku` is `unique: 'identity'` — duplicates are rejected
  by the database, not the form),
- live stock with +/− adjustments,
- orders that move `placed → picked → shipped → delivered`,
- every write is one transaction carrying `{ actor, action, ... }` metadata,
- an audit panel that *is* the transaction ledger,
- a time-travel panel that re-renders the whole dashboard "as of tx N".

## How to run

> Full build/run/troubleshooting details (ports, `?server=`, env vars, stale
> data reset) are in [docs/running-demo-apps.md](../../docs/running-demo-apps.md).

```bash
# from the repo root — build the workspace deps + this app first
npm run build

# terminal 1: the Fatos server (seeds ./data on first run, persists everything)
npm run server --workspace @fatos/app-ops-desk

# terminal 2: the browser client
npm run client --workspace @fatos/app-ops-desk
# → open http://localhost:4174  (pass ?server=ws://… to point elsewhere)
```

Try: adjust stock, advance an order, then drag the time-travel slider back and
watch the dashboard flip to the exact state at that transaction. Restart the
server — the audit trail and stock levels survive (`./data/ops-desk.json` +
append log).

## What it exercises

| Fatos feature | Where in the app |
|---|---|
| Schema as facts (valueType, cardinality, `unique: identity`) | `src/seed.ts`; a bare add of a second stock value is rejected over REST |
| Transaction metadata = audit trail | every button writes `{ actor, action, … }`; `AuditPanel` renders the ledger |
| `client.find(criteria, tx)` time travel | `TimeTravelPanel` scrubs any past state |
| Live queries with memoized snapshots | `InventoryPanel` / `OrdersPanel` via `useQuery` |
| Syncing client (WS live mirror, `afterTx` catch-up) | `useSyncedClient`; two tabs stay in sync |
| `FileAdapter` append + restart recovery | server seeds once, replays the log on restart |
| REST `POST /transact` with wire-tagged values | `src/api.ts` |

## Verdict

**Fit: strong — this is the most natural niche.** The temporal core is *load
bearing* here: an audit trail, "state as of last Tuesday", and immutable history
are not features we bolted on — they fell out of the data model. Two things
stood out as genuinely pleasant:

1. **The audit log is free.** No separate audit table, no event-sourcing
   ceremony. Every UI action that writes also writes its own provenance.
2. **Schema validation at the DB layer.** The cardinality/unique errors came
   back from the server even in the curl smoke test — forms get enforcement for
   free.

**Friction observed:**
- The client mirrors are read-only by design, so writes are a separate REST
  hop (`api.ts`) rather than `client.transact(...)` reaching the server. Fine
  for server-authoritative apps, but it means two code paths (mirror reads +
  REST writes) for one mental model.
- Range reads ("stock as of Tuesday" by *timestamp*, not tx id) need an
  extra mapping step — `at(tx)` is tx-id based.
- The "as-of" UI re-renders coarsely (subscribe + re-read). Live fine-grained
  reads for *current* state are solved; scrubbing is a per-render read.

**Bottom line:** if Fatos marketed itself as "the database for operations apps
that need history + audit + reactive dashboards," the demo sells itself.
