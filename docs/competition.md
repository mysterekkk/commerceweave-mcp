# Landscape (searched 2026-11-13)

Searches: GitHub (`allegro mcp`, `baselinker mcp`, `woocommerce mcp`, `ecommerce mcp server`) and npm (`allegro-mcp`, `baselinker-mcp`, `woocommerce-mcp`). No code from any of these projects was copied or read for reuse. Star counts and activity change quickly; treat the table as a snapshot.

| Project | Platform | Notes (from public listing only) | License |
|---|---|---|---|
| `allegro-mcp` (npm 0.2.1) | Allegro | "safe Allegro seller catalogue operations" | MIT |
| `Bilski311/allegro-mcp`, `wropol/AllegroMCP`, `ruslan-zhukouski/AllegroMCP` | Allegro | personal/unofficial Allegro access (several are buyer-side) | MIT / unspecified |
| `PiotrRaszkowski/baselinker-mcp` | Base.com | all 179 API methods in 10 category tools, stdio or OAuth | MIT |
| `konradbachowski/baselinker-mcp` | Base.com | ~150 methods, MCP server + CLI | MIT |
| `NorbertSo/baselinker-mcp` | Base.com | whole API, read-only | MIT |
| `techspawn/woocommerce-mcp-server` | WooCommerce | most-starred WooCommerce MCP found | MIT |
| `woocommerce/wc-mcp-ability`, WooCommerce MCP developer preview | WooCommerce | official WooCommerce integration (uses WordPress Application Passwords) | n/a |
| `wppoland/woocommerce-mcp`, `@sadrmanesh/woocommerce-mcp` | WooCommerce | read-only / multi-store variants | MIT |

Name collisions to be aware of: several "Allegro MCP" repos are about **Cadence Allegro PCB** software, unrelated.

## Where CommerceWeave is different (and where it is not)

Different:

1. One server for Allegro, Base.com **and** WooCommerce. We did not find another project covering all three.
2. One set of tool names and normalized models (`CommerceProduct`, `CommerceOrder`, …) that keep the platform ids.
3. Cross-platform questions: orders across stores, low stock, stock discrepancies, sales summary, with explicit completeness reporting.
4. Imported-order de-duplication (confirmed vs potential) so totals are not double counted.
5. Writes are proposals first, bound to an exact plan, and need a human approval in a separate terminal.
6. Local, no VPS, no database, no SaaS account.

Not different / not better:

- Breadth. The Base.com servers above expose far more API methods than the ~25 read/write paths here. If you need shipments, invoices, warehouses management or product creation in Base, use one of them. CommerceWeave is deliberately a small, safe surface.
- WooCommerce already has an official MCP integration; this project does not replace it.
- No live-account validation yet (see [api-compatibility.md](api-compatibility.md)).
