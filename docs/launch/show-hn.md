# Show HN draft (do not post automatically)

**Title:** Show HN: CommerceWeave, one local MCP server for Allegro, Base.com and WooCommerce

**Text:**

I built a small MCP server that lets an AI client query several e-commerce platforms through one set of tools, running locally over stdio (no hosted component).

What it does: normalized products/orders across Allegro, Base.com and WooCommerce; cross-store questions (today's orders, low stock, stock differences between stores, 7-day sales); imported-order de-duplication so an Allegro order that also lives in Base is not counted twice.

What I cared about most is safety, since agents misread instructions: it is read-only by default. Writes (stock, price, order status) are proposals with before/after values. To execute one, a human has to run `commerceweave-mcp approve <id>` in a terminal and type a code; the approval is single-use, expires, is bound to the exact plan, and execution aborts if the live value changed. There is no tool the model can call to approve.

Limits, up front: it has not been run against live accounts yet (tests use local servers that implement each platform's documented protocol and real stdio MCP sessions). It covers about 25 operations, far fewer than dedicated single-platform MCP servers. If an agent has a shell on your account it can bypass the terminal approval; that is documented.

Repo: https://github.com/mysterekkk/commerceweave-mcp (MIT). Feedback on the approval model especially welcome.
