# WebDiDau Project Guidelines

## Architecture

- Monorepo npm workspaces: `apps/api` (Cloudflare Worker/Hono) and `apps/web` (React/Vite).
- Production entry: `apps/api/src/index.ts`.
- Production URL: `https://didau-travel.anhduong34205.workers.dev`.
- Cloudflare bindings: D1 `DB`, KV `CART`, Workers AI `AI`, Vectorize `VECTORIZE`, assets `ASSETS`.

## Change Rules

- Keep tour data as the closed-world source of truth. Do not invent tour facts, locations, prices, schedules, or services.
- Preserve the existing Hono API shape and React `api.ts` client contract.
- Never expose `ADMIN_TOKEN` in source, logs, chat responses, or examples.
- Use the repository-local schema and seed files for database changes.
- Make focused edits, then validate with typecheck and a behavior-scoped test.
- Do not run deployment unless requested or when completing a deployment workflow.

## Standard Commands

- `npm run typecheck`
- `npm run build`
- `npm run deploy`
- `npm run dev`
- `npm run db:init` for the local D1 database

## RAG Rules

- Embed tours with `@cf/baai/bge-m3`.
- Query Vectorize with cosine similarity and keep the retrieved top-k small.
- Apply budget and direct-tour guardrails after retrieval.
- Keep prompt context within the model context limit; send retrieved tours, not the entire catalog.
- Reindex Vectorize after tour create/update/archive or catalog embedding changes.
