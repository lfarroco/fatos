# @fatos/examples

Runnable example programs that showcase what Fatos can do.

Every example is a small TypeScript program with a `run()` function. Each one
prints its results to the console, and the test suite (`src/index.test.ts`)
runs the same `run()` functions and asserts on their behavior — so an example
that runs is also an example that is verified.

## Examples

| Example | Source | Highlights |
| --- | --- | --- |
| `basic` | `src/basic-usage.ts` | The core database API: add/retract/transact immutable facts, ergonomic tuples, string entity ids, `entity`/`find`, index-backed fact lookups, transaction history |
| `schema` | `src/schema.ts` | Schema as facts: value types, cardinality `one`/`many`, validation errors, the retract-then-add update pattern |
| `query` | `src/datalog-query.ts` | Datalog-style `find`/`where` queries: joins, projections, constants, deduplication, cardinality-many matches, transaction-scoped reads |
| `time-travel` | `src/time-travel.ts` | Temporal reads: reconstruct any past state with `atTransaction(tx)`, audit trail from transaction metadata, full append-only fact history |
| `reactive` | `src/reactive.ts` | The reactive client: `observe`, `observeEntity`, `observeQuery`, `observeTransactions` push only when results change |
| `server` | `src/server-example.ts` | The Node.js server: REST API (`/health`, `/transact`, `/facts`, `/transactions`) and real-time WebSocket broadcast |
| `react` | `src/react-example.tsx` | React integration: `FatosProvider` plus `useQuery`, `useEntity`, `useDatalogQuery`, `useTransaction`, `useFatosClient` in a small todo app |
| `schema-designer` | `src/schema-designer.ts` | Schema designer documents: editor helpers, import/export validation, conversion to Fatos transactions, and Fatos snapshot round-trips |
| `full-stack` | `src/full-stack-app.ts` | An end-to-end app: two clients share one server — REST writes, live WebSocket sync, and time-travel reads over HTTP |
| `browser-harness` | `src/browser-harness.ts` + `browser-harness.html` | A browser page that publishes live `FactSnapshot`s to the Fatos DevTools panel: seed a demo client, then add/retract/transact and watch the panel update |

`src/index.ts` exports `runAll()`, which runs every example back to back.
`src/cli.ts` is the CLI entry point used by the `example:*` scripts and the
built bundle.

## Run them

From the repository root, build the workspace packages first:

```bash
npm run build --workspace @fatos/core --workspace @fatos/client --workspace @fatos/server --workspace @fatos/react --workspace @fatos/schema-designer
```

Then run the whole showcase in one go:

```bash
npm run start --workspace @fatos/examples
```

Or run individual examples (fast, no build needed):

```bash
npm run example --workspace @fatos/examples            # all examples
npm run example:basic --workspace @fatos/examples      # one example
npm run example:time-travel --workspace @fatos/examples
npm run example:full-stack --workspace @fatos/examples
```

The available scripts are `example:basic`, `example:schema`, `example:query`,
`example:time-travel`, `example:reactive`, `example:server`, `example:react`,
`example:schema-designer`, and `example:full-stack`.

If you are inside `packages/examples`, drop the `--workspace` flag:

```bash
npm run example:react
```

## DevTools browser harness

`browser-harness.html` is a standalone demo page that publishes live
`FactSnapshot`s to the Fatos DevTools panel (the page-side half of the
devtools bridge). It is the missing producer the panel needs: without it the
panel degrades to "waiting for snapshot".

Build it (this also bundles `@fatos/client`/`@fatos/core`/`@fatos/devtools`
into the self-contained `dist/browser-harness.global.js`, so no bundler or
server dependencies are needed):

```bash
npm run build
```

Then serve `packages/examples` over HTTP (the extension content script only
runs on http/https pages), e.g.:

```bash
npx serve .
# or: python3 -m http.server 8080
```

Open `http://localhost:8080/browser-harness.html` in Chrome with the Fatos
DevTools extension installed, and open DevTools → the **Fatos** panel. The
page seeds a demo client and re-publishes a full snapshot on every write
(plus an initial snapshot on load); the panel's **Inspect** button requests
one on demand. Use the page's buttons to add facts, toggle a value, or
transact an order status update and watch the Facts/Timeline/Diff tabs change.

## Tests

```bash
npm run test --workspace @fatos/examples
```

## Notes

- Examples use real, running instances of the packages (the server example
  starts an actual `FatosServer` on an ephemeral port).
- The retract-then-add update pattern is shown as two separate transactions
  (retract the old value, then add the new one) — the append-only model keeps
  every step in the history.
