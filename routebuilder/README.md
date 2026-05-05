# Route Builder POC

Three-screen demo app for ICL owners: pick a rep, see their Opportunities on a map, build a walking route (auto or by hand), save it.

This folder is a sibling of `address_order_method/` inside the `maps` repo. The backend imports `route_core.build_routes_from_dataframe` from `address_order_method` directly — do not duplicate the algorithm.

```
routebuilder/
  backend/        FastAPI service (deploy to Railway)
  frontend/       Next.js 15 app (deploy to Vercel)
  supabase/       SQL migrations
```

## Local development

### 1. Supabase

Create a Supabase project, then apply the schema:

```bash
psql "$SUPABASE_DB_URL" -f supabase/migrations/001_init.sql
```

Or paste `supabase/migrations/001_init.sql` into the Supabase SQL editor.

### 2. Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # fill in Salesforce + Supabase creds
uvicorn app.main:app --reload --port 8000
```

Smoke test:

```bash
curl http://localhost:8000/api/health
curl 'http://localhost:8000/api/reps?icl_code=GAC6'
```

### 3. Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

Open http://localhost:3000.

## Demo cache fallback

If Salesforce auth fails mid-demo, append `?demo_mode=cache` to the URL. The frontend will serve a baked-in roster + opportunity set + auto-route snapshot from `frontend/lib/demoCache.ts`. **At end of Wednesday's dry-run, replace those placeholders with a real captured response (Tony Bao or Brandon Brown, ICL `GAC6`).**

## Deploy

### Backend → Railway
- New project → deploy from this folder, root set to `routebuilder/backend/`
- `railway.json` and `Procfile` are already in place
- Set env vars from `.env.example`
- Confirm `/api/health` returns 200

### Frontend → Vercel
- Import the `maps` repo, set root to `routebuilder/frontend/`
- Set env vars: `NEXT_PUBLIC_API_BASE_URL` (Railway URL), `NEXT_PUBLIC_DEMO_ICL_CODE`
- The backend's CORS already allows `*.vercel.app`

## Things to ask Travis before the demo
- Salesforce credentials: `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_USERNAME`, `SF_PASSWORD`, `SF_SECURITY_TOKEN`
- Supabase project URL + service role key
- Railway and Vercel team access
- Demo hardware (touchscreen vs. laptop) — affects pointer-event testing for draw mode
- Confirm ICL `GAC6` is the right demo ICL

## Architecture notes

- The first row of the input DataFrame is the starting stop. `routes.py` reorders so the user's starting opp is row 0 before calling `route_core`.
- `route_core` is treated as the source of truth — never modified, never ported to JS.
- Salesforce token cache: 90 minutes (per Salesforce_Auth_reference.md).
- Storing both `auto_route_snapshot` and `ordered_stops` for `mode='drawn'` rows preserves the labeled-correction signal for the next phase. Don't drop this.
