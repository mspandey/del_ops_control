<div align="center">
  <h1>DEL Ops Control Center</h1>
  <p><b>Frontend Wars 2026 · Grand Finale Winning Submission</b></p>

  [![Deploy with Vercel](https://vercel.com/button)](https://del-ops-control.vercel.app)
  <br/>
  
  <p>
    An intelligent, single-page command center that turns 8 fragmented airport data sources into unified, real-time operational intelligence.
  </p>
</div>

---

## 🏆 The Challenge
Airport operators are overwhelmed by disjointed data. For this grand finale, we were provided with eight massive, disjointed CSV files covering flights, passengers, baggage, crew, and maintenance—spanning three months of operations. 

The task: Build a unified dashboard to synthesize these 8 raw datasets into a single source of truth for airport controllers, helping them spot delays, mitigate gate conflicts, and manage crises.

## 🚀 The Solution
**DEL Ops Control Center** is a high-performance, single-page application built entirely in **Vanilla JavaScript**. It loads the entire dataset into memory and provides an ultra-fast, time-traveling dashboard capable of slicing through operational data at 60 frames per second.

### Key Features
* ⏱️ **Time-Travel Debugging (The Scrubber):** Airport operations are heavily time-dependent. We built an interactive timeline scrubber that allows operators to travel through three months of data. Every KPI, gate status, and alert dynamically updates to reflect the exact state of the airport at that millisecond.
* 🧠 **Relational Cross-Filtering:** Click on any flight, gate, or incident, and the dashboard dynamically joins the `flights`, `passengers`, `baggage`, and `maintenance` tables in real-time, pulling up a deep contextual side drawer without losing the top-level overview.
* ⚡ **Command Palette:** Built for power users. Press `Ctrl+K` to open a spotlight-style command palette. Search for specific flights (e.g., `FL-1200`), jump to gates (e.g., `G12`), or toggle Dark Mode instantly.
* 🚨 **Automated Crisis Detection:** The Live Incident Feed automatically scans the dataset for delays, gate conflicts, and maintenance clashes, applying a high-contrast severity scale to bubble the most critical issues to the top.
* 🔴 **Crisis Simulation Mode:** A one-click stress test that automatically scrubs the timeline to the exact 30-minute window with the highest concentration of severe alerts in the entire dataset.

## 🛠️ Technical Architecture & Stack
This project was built to prove that you don't need a heavy framework to build a complex, data-heavy, reactive dashboard. 

* **Vanilla JavaScript:** 100% custom state management and reactivity. No React, Vue, or Svelte.
* **Vanilla CSS:** A custom design token system, CSS Grid layouts, and severity-tiered styling. No Tailwind.
* **Semantic HTML5:** Built for accessibility and native browser performance.
* **In-Memory Graph:** All 8 CSVs were parsed and bundled into a single JS file (`data.js`) providing instant relational joins on the client side without database latency.

## 💻 Running Locally

Running the control center is incredibly simple. You just need to serve the static files.

1. Clone the repository:
   ```bash
   git clone https://github.com/mspandey/del_ops_control.git
   cd del_ops_control
   ```

2. Start a local HTTP server. For example, using Python:
   ```bash
   python -m http.server 8080
   ```
   Or using Node.js:
   ```bash
   npx serve .
   ```

3. Open your browser and navigate to `http://localhost:8080/`.

---
<div align="center">
  <i>Designed and built for Frontend Wars 2026. Data visualization meets operational command.</i>
</div>
