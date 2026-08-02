# DEL Ops Control — Airport Operations Control Center

Frontend Wars 2026 — Grand Finale submission. A real-time control-room dashboard for Indira Gandhi International Airport (DEL), built entirely client-side from the eight provided CSV datasets.

## Run it

No build step, no install. Just open `index.html` in a browser — everything (including the parsed dataset) is a static asset.

```
DEL-Ops-Control-Center/
├── index.html      ← open this
├── styles.css
├── app.js           ← all application logic
├── data.js           ← dataset, pre-parsed from the provided CSVs (see below)
├── data/               ← original provided CSVs + data dictionary, for reference/verification
└── README.md
```

To deploy: drag this folder onto [Netlify Drop](https://app.netlify.com/drop), or push it to a GitHub repo and enable GitHub Pages on the root — either gives you a live link with zero configuration, since there's nothing to build.

## Tech stack

Vanilla HTML/CSS/JS. No framework, no bundler, no dependencies at runtime. This was a deliberate choice given the rules (frontend-only, no external DB, dataset-driven) and the time available — every line is inspectable, there's no build step to fail during judging, and it loads instantly offline.

## A note on the dataset

**The eight provided CSVs ship with positional headers only** (`0,1,2,3…`), not descriptive column names — `data_dictionary.md` documents the tables, not the individual fields. Before building anything, I profiled every column across the full files (value ranges, cardinality, constant vs. varying fields) and reverse-engineered a schema, joining on `flight_id`, `pnr`, `tail_number`, and `passport_masked` per the relationships described in the dictionary. That mapping is what `data.js` was generated from — the original untouched CSVs are kept in `/data` alongside it so the mapping can be checked against the source.

Worth noting for anyone extending this: several tables (`baggage`, `gate_events`, `security_screening`, `staff_shifts`, `retail_transactions`, `maintenance_logs`) have most of their categorical fields fixed to a single value across every row (e.g. every gate event is `"Boarding Start"`, every bag is `"Loaded"` at `"Ramp"`). The IDs, timestamps, and numeric fields (weights, queue positions, durations, revenue, downtime hours) vary properly and are what the cross-table joins and alert engine are built on.

## Features

- **Timeline scrubber** — drag or play through the full Oct–Dec 2024 dataset window at 15×–900× speed; the clock, KPIs, gate grid, alerts, and every tab re-derive their state live from whatever moment you're at, rather than showing static totals.
- **Compound alert engine** — not just "flight is late": alerts are computed by crossing tables — severe delays, two flights assigned overlapping windows on the same gate, an aircraft still in an open maintenance work order when its next flight is due, and security queue surges from live throughput.
- **Passenger trace** — search a PNR and get a single assembled journey (check-in → security lane & wait → baggage → gate boarding) pulled from four separate tables into one timeline.
- **Flight detail drawer** — click any flight anywhere in the app for its full cross-table picture: passengers by cabin class, linked baggage and total weight, gate events, and the aircraft's maintenance history.
- **Six operational tabs** — Overview, Flights (searchable/sortable/filterable board), Passenger Trace, Security, Staff, Retail, Maintenance — each reading from a different combination of the eight source tables.

## Design

Control-room aesthetic (charcoal/graphite, warm white, olive/gold/burnt-orange status colors, tabular-numeral monospace for all timestamps) rather than a generic SaaS-dashboard look — deliberately avoiding blue/purple gradients and glassmorphism per the brief. Details in the accompanying design spec.

## Accessibility

Semantic landmarks, `role="tablist"`/`role="tab"`, keyboard-operable scrubber and drawer (Esc to close, Space to play/pause), visible focus states, `aria-live` regions on KPIs and main panel, `prefers-reduced-motion` respected on the live-indicator pulse.
