# Documentation

Guides for the current Fatos packages:

- [@fatos/client Guide](./client-guide.md)
- [@fatos/react Guide](./react-guide.md)

## Design

The JS-native API design series — the contract that implementation work is built against:

- [Design index](./design/README.md)
- [Data Model — values, refs, tempids, schema, entity state](./design/01-data-model.md)
- [Transact & Query — insert/pull/operators, time travel](./design/02-transact-and-query.md)
- [Reactivity & Wire — live queries, EventTarget, React, transport](./design/03-reactivity-and-wire.md)
- [Implementation Phasing — P0–P4 with acceptance criteria](./design/04-phasing.md)

## Comparisons & Gap Analysis

How Fatos stacks up against the Datalog ecosystem, and what it would take to close the gap:

- [Fatos vs. Datomic vs. DataScript](./comparison-datomic-datascript.md) — positioning, feature-by-feature comparison, advantages, and downsides
- [Gap Analysis — querying, schema, rules](./gap-analysis-query-schema-rules.md) — itemized gaps with status flags (✅ implemented / 📋 designed / ❌ missing) and a priority roadmap
