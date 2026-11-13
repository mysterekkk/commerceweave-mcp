---
title: "Giving an AI agent access to three e-commerce platforms without giving it the keys"
published: false
tags: mcp, ai, typescript, ecommerce
---

(Draft. Not published automatically.)

Connecting an AI assistant to a shop is easy. Doing it so that a confused or prompt-injected model cannot reprice your catalogue is the interesting part. This post describes the design of [CommerceWeave MCP](https://github.com/mysterekkk/commerceweave-mcp), a local MCP server for Allegro, Base.com and WooCommerce.

## One interface

Each platform has its own idea of a product (Woo variations, Base catalogs and warehouses, Allegro offers). The server keeps platform ids but returns one shape, so "what is running low?" is a single tool call across stores. Honest nulls matter: Woo stock that is not managed is `null`, not `0`.

## Do not count a sale twice

An Allegro order imported into Base appears in both APIs. If Base's `external_order_id` equals the Allegro order id, the copy is a *confirmed* duplicate and is excluded from totals. If only a shop order id and amount line up, it is a *potential* duplicate: counted, flagged, reported separately. Currencies are never mixed and revenue is never called profit.

## Writes that a model cannot grant itself

1. Default mode is read-only: write tools are not even registered.
2. In proposal mode, `prepare_*` reads the live value and stores a plan with before/after and a hash.
3. In approval mode, a human runs `commerceweave-mcp approve <id>` in a terminal and types a code derived from the plan hash. The approval record is HMAC-authenticated, single-use, expiring.
4. Execution claims the approval atomically (rename) before any network call, re-reads live values and aborts on drift, never retries writes, and reads results back.

There is no tool named approve, so a prompt-injected order note cannot talk the server into anything. The honest limit: an agent with a shell on your account could bypass the terminal. The docs say so.

## Testing without live accounts

I do not have production or sandbox credentials, so tests run the real connectors against local HTTP servers that implement each platform's *documented* protocol (including Base returning errors inside HTTP 200 and Allegro's async command API), and drive the compiled server with the official MCP client over stdio. That found a real bug (an empty path turned `connector.php` into `connector.php/`), but it is not a substitute for live validation, and the README says so.

Repo (MIT): https://github.com/mysterekkk/commerceweave-mcp
