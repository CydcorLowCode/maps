# Agent Handoff: Route Builder POC

You are building a proof-of-concept web application that demonstrates a path forward for sales rep route planning at Cydcor. This document is the spec. Read it end to end before writing code.

---

## 0. Context You Need

**This is a POC, not v1.** It is being demoed to executives on Thursday after a previous routing initiative shipped a process that did not match how reps actually walk. The point of the demo is to reset the conversation and prove a credible path forward — not to ship production software.

**This POC lives inside the existing `maps` repo** in a new sibling folder alongside `address_order_method/` and `coordinate_geometry_method/`. Do not modify code in those existing folders. Import from `address_order_method/route_core.py` as a Python module.

**Read these first** before writing any code:

1. `maps/README.md` — repo structure
2. `maps/AGENT_HANDOFF.md` — the mental model for routing, captured from prior work. The "Current Mental Model" section (parsing → editable segments → initial heuristic → human correction → learning) is the foundation this POC is built on.
3. `maps/address_order_method/README.md` — the algorithm we are productizing
4. `maps/address_order_method/route_core.py` — the algorithm itself. You will call `build_routes_from_dataframe()` as the source of truth. Do not port it to JS. Do not modify it. If you find a bug in it, document it and ask Travis before changing.

**The address-order method works because it matches how reps think:** street name + odd/even side + house-number block. "Walk down the even side of Indian Oaks from 600 to 999, cross at the end, walk back the odd side." The geometric approaches we tried before zigzagged and jumped sections because they tried to derive that mental model from coordinates instead of starting from it. Lat/lng is only used to draw the picture and to compute inter-segment transition distances.

---

## 1. What You Are Building

A polished single-page web application with three screens:

1. **Roster** — ICL owner picks a rep from a list showing their assigned Opportunity counts.
2. **Map** — selected rep's Opportunities render as pins on a map, with two route-building modes available.
3. **Saved routes** — list of routes the owner has saved, with a way to view each one.

There is one persona in this POC: the **ICL owner**. Reps don't sign in. There is no rep-facing view. Don't build for any other persona.

### 1.1 Two route-building modes (both available on the map screen)

**Mode A — Auto-build.** Owner picks a starting Opportunity (a pin on the map). Owner clicks "Build Route." The backend runs `address_order_method` on the rep's full Opportunity set with min/max stops per route (defaults: 45–75, target 60), starting from the selected Opportunity. The algorithm may produce one route or multiple routes if the rep has more leads than fit in one walk. Each route renders as a numbered, color-segmented polyline on the map.

**Mode B — Draw.** Owner taps "Draw Route." The map clears any generated route lines but keeps the pins. Owner finger-traces (or mouse-drags) through pins in walking order. Pins highlight as they're picked up. The result is a single route. (See section 5 for the existing draw-mode reference implementation.)

Either mode produces a saved route record with the same shape. Both modes are first-class — neither is a "fallback." On the demo, we intentionally use both so the audience sees the auto-build is great when it works and there's a fast manual escape hatch when it doesn't.

### 1.2 What is explicitly out of scope

- Writing routes back to Salesforce. Save to Supabase only.
- Any rep-facing experience.
- Multi-rep batch routing or assignment workflows.
- Closed-loop learning (we capture corrections; we don't yet feed them back into the algorithm).
- Production-grade auth. A single demo login is fine.

---

## 2. Architecture

Three components, tight boundaries, deliberately small surface area.

### 2.1 Frontend

- **Next.js 15 (App Router) + React 19 + TypeScript**, deployed to Vercel.
- **Tailwind CSS** with a small custom design system. No off-the-shelf component library. The visual design must look polished — this is an exec demo, not a hackathon prototype. Refer to the existing route-drawer prototype in this conversation for the visual direction (Fraunces serif headers, JetBrains Mono UI labels, paper-and-ink palette, accent red).
- **Leaflet 1.9 + OpenStreetMap tiles** for the map.
- **TanStack Query** for server state. Local component state for draw interactions.
- **Auth** — Supabase Auth, magic-link. For the POC, hardcoding a single demo user is acceptable. Don't build a sign-up flow.

### 2.2 Backend

- **FastAPI (Python 3.11+)**, deployed to **Railway** (preferred) or **Fly.io**. Vercel Python serverless functions are too constrained for our use case (Salesforce auth + algorithm needs ≥10s execution).
- **Salesforce client**: `simple-salesforce`. Use the OAuth 2.0 Resource Owner Password Credentials Flow exactly as described in `Salesforce_Auth_reference.md` — username + password (with appended security token if required) + client ID + client secret. Cache tokens for 90 minutes. Travis prefers this method for POCs and will provide credentials.
- **Algorithm**: import `route_core` from the `address_order_method` folder. Do not duplicate or rewrite it.
- **Storage**: Supabase Postgres. Schema below.

### 2.3 Folder structure inside the maps repo

```
maps/
  address_order_method/        # existing — read only
  address_order_method_archive/ # existing — ignore
  coordinate_geometry_method/  # existing — ignore
  salesforce_routes/           # existing — ignore unless useful as reference
  route_builder_poc/           # YOU CREATE THIS
    README.md                  # how to run locally
    backend/                   # FastAPI service
      app/
        main.py                # FastAPI app, route definitions
        salesforce.py          # auth + queries
        routes.py              # wraps route_core
        storage.py             # Supabase client
        models.py              # Pydantic schemas
      requirements.txt
      .env.example
    frontend/                  # Next.js app
      app/
      components/
      lib/
      package.json
      .env.local.example
    supabase/
      migrations/              # SQL schema migrations
```

### 2.4 API surface

Five endpoints. Keep them simple and JSON-only.

```
GET  /api/health                                  → liveness check
GET  /api/reps?icl_code={code}                    → roster for an ICL owner
GET  /api/reps/{owner_id}/opportunities           → unrouted pins for one rep
POST /api/routes/auto                             → run address-order algorithm
POST /api/routes/save                             → persist final route
GET  /api/routes?icl_code={code}                  → list saved routes
GET  /api/routes/{route_id}                       → single saved route detail
```

See section 4 for exact request/response shapes.

---

## 3. Salesforce: how to query

**Travis confirmed via the Salesforce MCP that these queries return useful data and the field shapes are stable. Use these patterns. Do not improvise.**

### 3.1 Critical Salesforce gotchas — read these first

- **`Owner` is polymorphic.** An Opportunity's owner is sometimes a `User` (a real rep) and sometimes a `Group` (an ICL Office Queue). Reps are owners only after they "claim" an opp; everything else lives on the queue. **For the roster query, filter out queue users by Name pattern: `Owner.Name NOT LIKE '%Queue%'`.** Queue user records consistently follow the `'ICL Office ### Queue'` naming convention, so this is the reliable signal. Do not use `Owner.UserType` for this — it varies in ways that don't cleanly separate reps from queues.
- **`Owner.Type` is NOT a queryable field on Opportunity** — that errored. If you need to confirm a record is a real rep, fall back to a User lookup (`SELECT Id FROM User WHERE Id = :owner_id AND IsActive = true`).
- **An Opportunity's ICL is on the Opportunity, not the User.** The Opportunity has `ICL_Unified_Code__c`; the User has `Associated_ICL_Unified_Code__c`. These can drift — a rep's home ICL on User can differ from where their assigned opps actually live. **The Opportunity's `ICL_Unified_Code__c` is the source of truth for "what ICL is this opp in."** Filter on the Opportunity field, not the User field.
- **Aggregate queries on Opportunity time out without a date filter.** Always add `CreatedDate = LAST_N_DAYS:N` (e.g., `:30` or `:60`) to GROUP BY queries. Without that, you'll hit query timeouts.
- **Address fields on Opportunity are custom, not standard.** It's `Street__c`, `City__c`, `State_Province__c`, `PostalCode__c` — NOT `Street`, `City`, `State`, `PostalCode`. The standard fields don't exist on Opportunity.
- **`House_Number__c` is often null** even when `Street__c` contains a clearly-numbered address like "1367 Andes Ct". `route_core.py` parses house number out of `Street__c` itself, so always pass `Street__c` through to the algorithm. Don't rely on `House_Number__c` being populated.
- **Geo fields**: use `Opportunity_GeoLocation__Latitude__s` and `Opportunity_GeoLocation__Longitude__s`. There's also `GeoCode_Geolocation__Latitude__s/Longitude__s` — prefer the first; fall back to the second only if the first is null.
- **Address strings have inconsistent spacing.** Real values include `"7751  Indian Springs Dr"` (double space) and `"4608 Sandy Creek Rd"`. Don't trim or normalize on read — `route_core.canonical_street_name` handles that.

### 3.2 The three queries you need

#### Query A — Roster: reps in an ICL with their unrouted Opportunity counts

```sql
SELECT
  OwnerId,
  Owner.Name,
  COUNT(Id) total
FROM Opportunity
WHERE
  ICL_Unified_Code__c = :icl_code
  AND IsClosed = false
  AND CreatedDate = LAST_N_DAYS:60
  AND Opportunity_GeoLocation__Latitude__s != null
  AND OwnerId IN (SELECT Id FROM User WHERE IsActive = true AND (NOT Name LIKE '%Queue%'))
GROUP BY OwnerId, Owner.Name
ORDER BY COUNT(Id) DESC
LIMIT 50
```

This returns rows like `{ OwnerId, Name, total }`. Map directly to the roster response. **Add `LAST_N_DAYS:60`** — without it, the query times out. If Travis wants longer history we can revisit, but 60 days is the right default for "active workload."

The `NOT Name LIKE '%Queue%'` filter excludes the ICL Office queue users (records like "ICL Office 1000002355 Queue") which own most opportunities until a rep claims them. The naming convention is consistent across the org.

For the demo we want to confirm the demo rep shows up. Tony Bao (`005Qi00000WqlurIAB`) and Brandon Brown (`005Qi00000WOBWBIA5`) in ICL `GAC6` are confirmed-good demo targets.

#### Query B — Pins for a selected rep

```sql
SELECT
  Id,
  Name,
  Street__c,
  City__c,
  State_Province__c,
  PostalCode__c,
  Street_Name_Only__c,
  Opportunity_GeoLocation__Latitude__s,
  Opportunity_GeoLocation__Longitude__s,
  GeoCode_Geolocation__Latitude__s,
  GeoCode_Geolocation__Longitude__s,
  StageName,
  Lead_Expiration__c,
  ICL_Unified_Code__c
FROM Opportunity
WHERE
  OwnerId = :owner_id
  AND IsClosed = false
  AND (Opportunity_GeoLocation__Latitude__s != null OR GeoCode_Geolocation__Latitude__s != null)
ORDER BY Street_Name_Only__c, Street__c
LIMIT 2000
```

Coalesce the two geolocation pairs in code: `lat = Opportunity_GeoLocation__Latitude__s ?? GeoCode_Geolocation__Latitude__s`.

#### Query C — Auth confirmation (use during dev, not in prod)

```sql
SELECT Id, Name FROM User WHERE Id = :session_user_id
```

For the POC, the "ICL code" the owner is scoped to is hardcoded (or pulled from a single demo user record's `ICL_Code_for_ICL_Owner__c`). Do not build a multi-tenant scoping layer.

### 3.3 Field reference

These are the only Salesforce fields the POC reads:

**Opportunity:** `Id`, `Name`, `OwnerId`, `IsClosed`, `Street__c`, `City__c`, `State_Province__c`, `PostalCode__c`, `Street_Name_Only__c`, `Opportunity_GeoLocation__Latitude__s`, `Opportunity_GeoLocation__Longitude__s`, `GeoCode_Geolocation__Latitude__s`, `GeoCode_Geolocation__Longitude__s`, `StageName`, `Lead_Expiration__c`, `ICL_Unified_Code__c`, `CreatedDate`.

**User:** `Id`, `Name`, `IsActive`.

Nothing else.

---

## 4. Wiring the algorithm to the API

`route_core.build_routes_from_dataframe()` is the function you call. Its signature:

```python
def build_routes_from_dataframe(
    raw_df: pd.DataFrame,
    min_stops: int = 45,
    max_stops: int = 75,
    target_stops: int = 60,
    first_side: str = "auto",
    street_order: str = "name",
    block_size: int = 100,
    use_block_segments: bool = True,
    use_side_segments: bool = True,
    segment_overrides: Optional[pd.DataFrame] = None,
) -> Tuple[pd.DataFrame, pd.DataFrame]:
```

It returns `(ordered, segment_summary)`.

The function expects a DataFrame with columns: `Street`, `Latitude`, `Longitude`, and either `Stop #` or it will assign one. The first row of the input DataFrame is the **starting stop**. (See `prepare_dataframe` in `route_core.py`.)

So the `/api/routes/auto` flow is:

1. Receive request: `{ owner_id, opportunity_ids, starting_opportunity_id, min_stops, max_stops, target_stops }`
2. Look up the Opportunities (already cached on frontend; pass them in the request body to avoid a second SF round trip).
3. Build a pandas DataFrame from the opportunity list. **Put the `starting_opportunity_id` row first.**
4. Call `build_routes_from_dataframe(df, min_stops=min_stops, max_stops=max_stops, target_stops=target_stops)`.
5. Convert the resulting `ordered` DataFrame to JSON. Each row is one stop with: `Route #`, `Route Stop #`, `Canvass Unit ID`, `Segment Color`, `Segment Direction`, `Route Stop Range`, the original Opportunity `Id`, lat/lng, address.
6. Group by `Route #` server-side and return as `{ routes: [ { route_number, stops: [...], segment_summary: [...] } ] }`.

### 4.1 Request/response shapes

```typescript
// POST /api/routes/auto
type AutoRouteRequest = {
  owner_id: string;
  opportunities: Array<{
    id: string;             // Salesforce Id
    street: string;         // Street__c
    city: string;
    state: string;
    postal_code: string;
    lat: number;
    lng: number;
  }>;
  starting_opportunity_id: string;
  min_stops?: number;       // default 45
  max_stops?: number;       // default 75
  target_stops?: number;    // default 60
};

type AutoRouteResponse = {
  routes: Array<{
    route_number: number;
    stops: Array<{
      stop_number: number;
      opportunity_id: string;
      street: string;
      city: string;
      lat: number;
      lng: number;
      segment_id: string;
      segment_color: string;     // hex
      segment_direction: string; // 'forward' | 'reverse'
      stop_range: string;        // e.g. "1-12"
    }>;
    segments: Array<{
      segment_id: string;
      segment_order: number;
      stop_range: string;
      color: string;
      street_display: string;
      block_label: string;
      side_label: string;
      direction: string;
      stop_count: number;
    }>;
  }>;
};

// POST /api/routes/save
type SaveRouteRequest = {
  rep_owner_id: string;
  rep_name: string;
  icl_code: string;
  mode: 'auto' | 'drawn';
  ordered_stops: Array<{
    stop_number: number;
    opportunity_id: string;
    lat: number;
    lng: number;
  }>;
  // For 'drawn' mode, also include what auto would have produced (optional but valuable)
  auto_route_snapshot?: AutoRouteResponse;
  notes?: string;
};

type SaveRouteResponse = { id: string; created_at: string };
```

---

## 5. The draw-mode reference

A working finger-draw prototype already exists. You can find it in the conversation that produced this handoff (or ask Travis). Port the core interaction patterns into a React component:

- Snap radius circle that follows the cursor/finger (44px diameter, position: fixed for accurate tracking)
- Snap detection within ~22px of unvisited pins
- Visual states for pins: pending (outlined), visited (filled with order number)
- Trail polyline (dashed, faded) shown during draw, replaced with solid route polyline on completion
- Undo last pin and Clear actions
- Touch + mouse + pen support

Don't rebuild from scratch. The cursor-positioning bug ("circle below pointer") was already fixed in the prototype — make sure the React port uses `position: fixed` and viewport coordinates, not container-relative coordinates.

---

## 6. Supabase schema

```sql
-- migrations/001_init.sql

create extension if not exists "uuid-ossp";

create table saved_routes (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),

  rep_salesforce_id text not null,
  rep_name text not null,
  icl_code text not null,

  mode text not null check (mode in ('auto', 'drawn')),

  ordered_stops jsonb not null,        -- the final ordered list of stops
  auto_route_snapshot jsonb,           -- if mode='drawn', what auto would have produced
  input_snapshot jsonb,                -- the unordered opp list that was fed in
  algorithm_params jsonb,              -- {min_stops, max_stops, target_stops, starting_opportunity_id}

  notes text
);

create index saved_routes_icl_code_idx on saved_routes(icl_code);
create index saved_routes_created_at_idx on saved_routes(created_at desc);
create index saved_routes_rep_idx on saved_routes(rep_salesforce_id);
```

Storing both the auto suggestion and the drawn override on the same row is what makes this data valuable for the next phase. Every drawn save is a labeled training example of "the algorithm got this wrong, here's what right looks like." Don't drop this.

Skip RLS for the POC. One demo user, one ICL.

---

## 7. UI requirements

### 7.1 Roster screen

- Centered list, max width ~640px.
- Each row: rep name (left), opportunity count (right), tap target across the whole row.
- Reps with zero opportunities are dimmed and not clickable; tooltip explains why.
- Sort by opportunity count descending by default. No filter UI for the POC.
- Header: ICL code, owner name, "Roster" title.
- Loading state: skeleton rows, not a spinner.

### 7.2 Map screen

- Map fills the viewport minus a top header and a right sidebar (collapsible to a bottom sheet on narrow screens).
- Header: rep name, opportunity count, back button to roster.
- Right sidebar:
  - Top section: route stats (stop count, distance estimate, number of routes if multi-route).
  - Middle section: ordered list of stops grouped by route, with segment colors. Empty state for "no route yet" with onboarding text.
  - Bottom section: action buttons.
- Primary action: **"Build Route"** (after a starting pin is selected). Disabled until a starting pin is selected.
- Secondary action: **"Draw Route"**. Always enabled.
- After a route is built or drawn: **"Save Route"** appears.
- Pin states:
  - Default: white fill, dark border, no number.
  - Selected as starting point: red fill, dark border, no number.
  - Routed: filled with segment color, white number.
  - During draw: standard pin until snapped, then filled.
- Pin tap behavior:
  - Outside draw mode and before "Build": tapping selects/deselects the starting pin.
  - During draw: handled by the draw interaction.

### 7.3 Multi-route handling

When the algorithm returns multiple routes (rep has > max_stops opportunities), render each route as a separate colored polyline on the map and as a separate group in the sidebar list. Each route gets its own save action — don't bundle.

### 7.4 Visual polish — non-negotiable

This is an exec demo. The visual quality is half the pitch. Specifically:

- Use a custom font pairing (Fraunces or similar serif for headers, JetBrains Mono or similar mono for UI labels, system sans for body).
- Avoid generic AI-aesthetic dashboards (no gradient buttons, no rounded-2xl-everywhere, no "card with shadow" padding).
- Tight typography. Real letterspacing on labels. Real hierarchy.
- One accent color used sparingly. The route-drawer prototype uses a confident red `#d94f2c` over a paper background `#f4efe6`. That direction is good — use it or something equivalently distinctive.
- The map base layer should be unobtrusive. Consider CartoDB Positron tiles instead of default OSM if they look better with the design.
- Animations: subtle, fast (≤200ms), only on state changes that benefit from continuity.

---

## 8. Build order and milestones

**Day 1 (Tuesday)**
- Repo scaffold inside `maps/route_builder_poc/`.
- FastAPI skeleton deployed to Railway with `/api/health` returning 200.
- Salesforce auth working server-side. Run query A locally and confirm Tony Bao shows up for ICL `GAC6`.
- Next.js skeleton deployed to Vercel with the roster screen rendering live data from `/api/reps`.
- Supabase project created, schema applied.

**Day 2 (Wednesday)**
- Map screen: pin rendering for a selected rep using `/api/reps/{id}/opportunities`.
- Starting-pin selection flow.
- `/api/routes/auto` calling `route_core.build_routes_from_dataframe` and returning the structured response.
- Map renders the auto-route output with segment-colored polylines and numbered pins.
- Sidebar with stop list and route stats.
- `/api/routes/save` and the save flow.
- Saved routes listing screen.
- **End of day Wednesday: full demo dry-run on actual demo hardware.** Time the demo. Find the rough edges.

**Day 3 (Thursday morning)**
- Draw mode port from the existing prototype.
- Visual polish pass.
- Final dry run.
- **Demo data fallback**: cache one full successful auto-build response (Tony Bao or Brandon Brown) as JSON. If Salesforce auth fails mid-demo, the app reads from cache and the demo continues. Add a `?demo_mode=cache` query param that forces this.

If draw mode is not done by Wednesday end of day, it can ship Thursday morning. Auto mode + save is the must-have.

---

## 9. Things that will trip you up

- **Vercel + FastAPI**: Don't try to host the Python service on Vercel functions. The Salesforce auth + algorithm round-trip exceeds Vercel's free-tier execution limits. Use Railway. Travis has approved this.
- **CORS**: configure FastAPI CORS for the Vercel preview domain pattern (`*.vercel.app`) plus the production domain.
- **Salesforce token caching**: the auth guide says 90 minutes. Respect it. Don't authenticate per request.
- **Latitude/longitude precision**: Salesforce returns floats with up to 7 decimal places. Don't round. The algorithm's distance calculations care.
- **The first row of the input DataFrame is the starting stop**, per `route_core.py`. Do not pass opportunities in arbitrary order and expect the algorithm to figure out where to start. Reorder the DataFrame in the Python wrapper so the user-selected starting opp is row 0.
- **Address parsing edge cases**: `route_core.canonical_street_name` already handles `"AveSE"`, `"SE Ave"`, double spaces, and trailing unit markers. If you find a case it can't handle, log it and move on — do not modify `route_core.py`.
- **The address fields on Opportunity are custom (`__c`), not standard.** This is the most common mistake when querying Opportunity. Re-read section 3.1 if you forget.
- **Don't reach for an off-the-shelf component library** for visual polish. Use Tailwind primitives. shadcn/ui is acceptable for unstyled headless components (Dialog, Popover) but the visual layer is custom.

---

## 10. What "done" looks like

The demo flow works end to end on the demo hardware, against live Salesforce data, in under 90 seconds:

1. Open app → roster of reps in ICL `GAC6` loads from Salesforce.
2. Click Tony Bao → his ~85 Opportunities render as pins on a Norfolk, VA map.
3. Click a pin near a corner of the cluster → it turns red as the starting point.
4. Click "Build Route" → polylines and numbered pins render. The result looks like a sensible walking route with clear street-side sweeps.
5. Click "Save Route" → confirmation, route is in Supabase.
6. Click back, pick Brandon Brown → his Opportunities render.
7. Click "Draw Route" → trace through pins. Save.
8. Navigate to saved routes → both routes visible.

If that flow works, the POC is done. Anything beyond that is gravy.

If something on the path to that flow doesn't work by Wednesday evening, drop it, harden the cached-demo fallback, and rehearse around it. The demo is the artifact, not the code.

---

## 11. Questions to ask Travis if blocked

- Salesforce credentials (client ID, secret, username, password, security token if needed, login URL).
- Supabase project URL and anon/service keys.
- Vercel and Railway team access.
- Demo hardware specs (laptop vs. wall display, touchscreen behavior).
- Whether to use ICL `GAC6` or pick another ICL after live data review.

Don't guess on any of these. Ask early.

---

End of handoff.