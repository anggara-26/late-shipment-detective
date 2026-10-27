# Data

## Live mode (default): TPC-H in Zetaris
The Participant Setup Guide installs Zetaris with `ZETARIS_SEED_TPCH=true`, which seeds the
standard **TPC-H** benchmark dataset (synthetic orders, line items, suppliers, nations, regions).
The agents query these tables through Zetaris; nothing is copied into this repository.
Run `npm run discover` to find the table prefix in your install.

Tables and columns used: `lineitem` (l_orderkey, l_suppkey, l_quantity, l_shipdate, l_commitdate,
l_receiptdate, l_shipmode, l_shipinstruct), `orders` (o_orderkey, o_orderdate, o_orderpriority),
`supplier` (s_suppkey, s_nationkey), `nation` (n_nationkey, n_name, n_regionkey), `region` (r_regionkey, r_name).

A line item is **late** when `l_receiptdate > l_commitdate`.

## SAMPLE_MODE: generated sample
`SAMPLE_MODE=true` generates ~24k TPC-H-shaped line items in memory at start-up
(`src/adapters/sampleData.ts`, fixed seed) using the TPC-H dbgen date rules:
shipdate = orderdate + 1..121 days, commitdate = orderdate + 30..90, receiptdate = shipdate + 1..30.
It is input data only: no answers are stored, and the agents compute everything at run time.

All data is synthetic. No real company or personal data is used.
