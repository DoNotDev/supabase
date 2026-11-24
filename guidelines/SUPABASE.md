# Supabase

**From zero to a working Supabase backend. Covers Auth, PostgreSQL, Storage, Edge Functions, and deployment.**

---

## Step 1: Run Coach + Fill .env

```bash
dndev coach
```

This prints a numbered checklist of what to configure. For Supabase, you'll need:
- **Project URL** and **public key** - paste into your app's `.env`
- **service_role key** - paste into `.dndev.secrets` at project root
- **Access token** - paste into `.dndev.secrets` (needed for DB migrations via Management API)

Where to get them:
- URL + public key + service_role key: [Supabase Dashboard](https://supabase.com/dashboard) > your project > **Settings > API**
- Access token: [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) (account-level, not project-level)

Then run setup to validate and automate:

```bash
dndev setup
```

Setup validates your credentials, generates SQL migrations from entities, and pushes them via the Supabase Management API (HTTPS - no CLI needed).

---

## Step 2: Generate Tables from Entities

The framework generates PostgreSQL migrations from your entity definitions. This runs automatically as part of `dndev setup`, or you can run it separately:

```bash
dndev setup
```

During setup, the wizard detects your entities and generates SQL migrations.

**What it does:**
- Discovers entities (e.g. in `entities/` or your configured entity directory)
- For each entity: `CREATE TABLE` with columns mapped from field types (text, number, boolean, timestamptz, uuid, jsonb, etc.)
- Adds technical columns: `id` (uuid, default `gen_random_uuid()`), `user_id`, `created_at`, `updated_at` (with `DEFAULT now()`), `created_by_id`, `updated_by_id`, `status`
- Enables **Row Level Security (RLS)** and creates policies so rows are scoped by `auth.uid() = user_id`
- Adds a trigger so `updated_at` is set automatically on every `UPDATE`

Output is written to `supabase/migrations/` as a timestamped `.sql` file.

---

## Step 3: Apply Migrations

`dndev setup` pushes migrations automatically via the Supabase Management API. No CLI needed.

If you prefer to apply manually:

**Dashboard SQL Editor** - Copy the generated `.sql` file contents from `supabase/migrations/` into the SQL Editor in the Supabase Dashboard and run it.

---

## Step 4: Enable Supabase Services

Go to the Supabase Dashboard and configure:

**Authentication** (enabled by default on new projects):
- Authentication > Providers > Verify Email is enabled
- Add OAuth providers if needed (Google, GitHub, etc.)

**Storage** (optional - only if your app uploads files):
- Storage > Create bucket (e.g. `uploads`)
- Configure public or RLS policies as needed

---

## Auth Claims and Access Subscriptions

Authorization uses trusted `app_metadata` only (`raw_app_meta_data` in SQL). Editable `user_metadata` supplies profile name/avatar, not roles or grants. A signed-in user without an explicit application role defaults to `user`.

Auth owns the canonical `SubscriptionClaimsSchema` in core, independently of billing. Store access at `app_metadata.subscription`, exposed as `AuthUser.customClaims.subscription`. Required: `tier`, `status`, `subscriptionEnd` (ISO timestamp or null), `updatedAt` (ISO timestamp). `features` and `isDefault` are optional. Optional nullable `subscriptionId` / `customerId` and optional `cancelAtPeriodEnd` are deprecated billing projections; never fabricate them for generic access.

### Server-only grant / revoke

The caller must authenticate and authorize the actor for the target `uid` before invoking this helper. The server secret must never reach a browser or an unguarded endpoint.

```typescript
import * as v from 'valibot';
import { SubscriptionClaimsSchema } from '@donotdev/core/server';
import {
  createServerClient,
  SupabaseServerAuthAdapter,
} from '@donotdev/supabase/server';

async function writeAccess(
  url: string,
  serverSecret: string,
  uid: string,
  tier: 'pro' | 'free',
): Promise<void> {
  await new SupabaseServerAuthAdapter(createServerClient(url, serverSecret))
    .setCustomClaims(uid, {
      subscription: v.parse(SubscriptionClaimsSchema, {
        tier,
        status: 'active',
        subscriptionEnd: null,
        updatedAt: new Date().toISOString(),
      }),
    });
}
```

Use `pro` to grant, `free` to revoke. `setCustomClaims` merges top-level app metadata, preserving unrelated keys; send the **complete** nested subscription. Omitting the key leaves the grant intact. `{ subscription: null }` explicitly clears its value under merge and resolves to free; prefer a complete free object without billing IDs. Self-service claims functions block subscription updates.

After the write, explicitly sync the affected browser:

```typescript
import { getProvider } from '@donotdev/core';

const token = await getProvider('auth').refreshToken();
if (token === null) throw new Error('Auth refresh failed');
```

`refreshToken()` throws on provider error (e.g. Supabase `refresh_token_not_found`, wrapped with the original reason) and returns `null` only when the auth state changed during the refresh (sign-out, account switch) or no session exists. The existing provider method applies canonical auth state before successful resolution; there is no `useAuth` refresh selector. A server setter cannot remotely force another user's browser to refresh.

Absent/null subscription resolves to deterministic free. Malformed present claims fail/deny, not silently retain access; a flat `app_metadata.tier` is not a migration fallback. Tier guards/provider `hasTier()` are hierarchical and status-blind: they compare the declared tier, not `isActive` or expiry. Unknown/unconfigured tiers deny. `isActive` checks only `status === 'active'`; `subscriptionEnd` is not auto-enforced. Existing legacy/custom status strings remain accepted. Revoke by lowering/removing tier, not by changing status alone.

### Next proxy, SSR and revocation limits

With cookie sessions, the generated page proxy verifies every authenticated page request, refreshes expired tokens as needed, and forwards cookies whose user/claims are bound to that verified result. Documents (`Sec-Fetch-Mode: navigate`, or no Fetch Metadata) and every non-GET/HEAD request (Server Actions, including multipart / urlencoded POSTs without `Next-Action`): Auth `getUser()` (network round trip, current user record). Client-router fetches (GET/HEAD, `Sec-Fetch-Mode` not `navigate`: RSC soft navigations, prefetches): `getClaims()`, the token signature checked locally against the project's cached JWKS; the forwarded user is built from the verified claims only (no `email_confirmed_at`, so `emailVerified` is false there). Staleness bound: a profile change (`updateUserProfile`, metadata) shows up on soft navigations within one access-token lifetime (Auth JWT expiry, default 3600 s), or at once on the next document load; a revoked session stays valid until the token expires. Local verification needs asymmetric JWT signing keys; on the legacy HS256 secret `getClaims()` calls Auth (same verdict, no latency gain). Next strips its `RSC` / `Next-Router-Prefetch` headers before the proxy, hence the Fetch Metadata signal. On outage it removes unverified render identity from the forwarded request while retaining browser cookies. Never globally cache personal auth.

`AuthSessionSnapshot.userSubscription` supplies display-only request-local context during initialization; never seed singleton auth identity from SSR. Protected server operations require fresh trusted authorization. `getUser()` verification does **not** guarantee JWT revocation everywhere: direct RLS using `auth.jwt()` can see stale claims until token refresh/expiry. Immediate revocation requires an authoritative policy at the protected server/database operation; a page guard or browser refresh alone is insufficient.

---

## Edge Functions

Supabase Edge Functions run on Deno at the edge. If you selected functions during scaffolding, they're in `supabase/functions/`.

### CRUD Functions (one line)

```typescript
// supabase/functions/crud/index.ts
import * as entities from '../_shared/entities.ts';
import { createSupabaseCrudFunctions } from '@donotdev/functions/supabase';

const { serve } = createSupabaseCrudFunctions(entities);
Deno.serve(serve);
```

**Result:** Auto-generates create, get, list, update, delete, aggregate, and bulk handlers for each entity. The dispatcher routes via `_functionName` in the request body.

### Bulk (multi-row writes, partial success)

`SupabaseCrudAdapter.bulk()` writes directly through PostgREST under RLS — the same path as `add` / `update` / `delete`. No edge function, no migration.

```typescript
const result = await crudAdapter.bulk('products', {
  updates: ids.map((id) => ({ id, patch: { size: '50 ml' } })),
  deletes: ['p9'],
});
// → { insertedIds: [], updatedIds: [...written], deletedIds: [], failed: [{ op: 'delete', id: 'p9', error: '…' }] }
```

**Contract:**
- Partial success: rows that are written stay written; rows that are not are returned in `failed` with the reason (no rollback).
- Requests: deletes `.delete().in(id, ids)`, inserts one array insert, updates grouped by identical patch (`.update(patch).in(id, ids)`; one value on N rows = one request). Ids chunked by 100, 6 requests in flight.
- Rows RLS skips or that do not exist are not returned by the write and are reported failed ("affected 0 rows"), like `update()` / `delete()`.
- Session required (nothing written without one); `createdById` / `updatedById` stamped; timestamps left to the DB; camelCase → snake_case mapping as for single-row writes.
- Id collisions (same id in `updates` + `deletes`, or `inserts` + `updates`) reject up-front with `BulkCollisionError` before any write. Empty bulk (`{}`) is a no-op.

Server side, `createSupabaseCrudFunctions` still registers a `bulk_${collection}` edge handler (transactional, `crud_bulk` RPC migration) for server code that needs one transaction; the client adapter does not use it. The handler reads the stored status of each updated row before the RPC (it picks the patch's schema) and passes it as `p_expected_statuses`; `crud_bulk` locks the rows and rejects the whole bulk (`unavailable`, nothing written) when a status changed in between. Needs migration `20250101000006_crud_bulk_status_guard.sql` (5-argument `crud_bulk`, also fixes updates/deletes on `uuid` ids); apps created before it copy it from `packages/cli/templates/functions-supabase/supabase/migrations/`.

Edge Function rate limiting (`createSupabaseHandler`) calls the `public.rate_limit_check` RPC: migration `20250101000007_rate_limit_check.sql` (service_role only). Without it the limiter fails closed and every Edge Function call answers 429; apps created before it copy it from the same templates folder.

### Custom Functions (typed)

For single-operation, schema-validated endpoints (one handler, one schema):

```typescript
// supabase/functions/my-function/index.ts
import * as v from 'valibot';
import { createSupabaseHandler } from '@donotdev/functions/supabase';

const schema = v.object({ productId: v.string() });

export default createSupabaseHandler(
  'get_product_details',
  schema,
  async (data, ctx) => {
    const { data: product } = await ctx.supabaseAdmin
      .from('products')
      .select('*')
      .eq('id', data.productId)
      .single();
    return product;
  },
  'user'  // requiredRole (default)
);
```

**Context:** `ctx.uid`, `ctx.userRole`, `ctx.supabaseAdmin`. Rate limiting, metrics, auth, schema validation included.

### Custom Functions (lightweight)

For multi-action functions, webhooks, AI chat, or anything that needs raw `Request` access:

```typescript
// supabase/functions/my-function/index.ts
import { createEdgeFunction } from '@donotdev/functions/supabase';

// Auth required (default)
Deno.serve(createEdgeFunction(async (req, ctx) => {
  const body = await req.json();

  if (body.action === 'list') {
    const { data } = await ctx.supabaseAdmin.from('items').select('*');
    return ctx.json({ items: data });
  }

  return ctx.error('Unknown action');
}));
```

**Context:** `ctx.user` (`{ id, email }` or null), `ctx.supabaseAdmin` (service role), `ctx.userClient` (RLS-scoped), `ctx.json()`, `ctx.error()`, `ctx.respond()`.

```typescript
// No auth (public endpoint)
Deno.serve(createEdgeFunction(async (req, ctx) => {
  return ctx.json({ public: true });
}, { requireAuth: false }));

// Webhook with custom auth header
Deno.serve(createEdgeFunction(async (req, ctx) => {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return ctx.error('Missing signature', 401);
  // verify signature, handle event...
  return ctx.json({ received: true });
}, { requireAuth: false, extraHeaders: ['stripe-signature'] }));
```

Both `createSupabaseHandler` and `createEdgeFunction` handle CORS, OPTIONS preflight, and method checking. Never manually define `CORS_HEADERS` in edge functions.

### Admin User Listing

`useAuthUsers()` / `useAuth('listUsers')` (`@donotdev/auth`) call the admin-only `list-auth-users` edge function, which reads every account from `auth.admin.listUsers` (no view, no copy). Non-admins get 403.

```typescript
// supabase/functions/list-auth-users/index.ts
import { createListAuthUsers } from '@donotdev/functions/supabase';
Deno.serve(createListAuthUsers());
```

### Deploy Edge Functions

```bash
supabase functions deploy
```

Or deploy everything with:

```bash
dndev deploy
```

---

## Adapter Behavior (DB-Managed Timestamps)

Tables use **snake_case** column names and **timestamptz** for `created_at` / `updated_at`. The framework expects **camelCase** and **ISO date strings** in the app.

The **Supabase CRUD adapter** handles this automatically:

| Direction | Behavior |
|-----------|----------|
| **Read** (get, query, subscribe) | Rows from Supabase are normalized: snake_case to camelCase (e.g. `created_at` to `createdAt`), and timestamp columns are converted to ISO strings. Your UI receives the same shape as with Firebase. |
| **Write** (add, set, update) | The adapter does **not** send `createdAt` / `updatedAt` (or snake equivalents). The database sets them via `DEFAULT now()` and the `updated_at` trigger. |

You never set timestamps in app code - the DB owns them.

---

## Environment Variables

**Client (Vite):** in `apps/<app>/.env`

| Variable | Purpose |
|----------|---------|
| `VITE_SUPABASE_URL` | Project URL (public) |
| `VITE_SUPABASE_PUBLIC_KEY` | Public key (safe in bundle) |
| `VITE_TURNSTILE_SITE_KEY` | Optional. Turnstile site key: turns on the framework CAPTCHA of Supabase Auth (widget in the auth forms, `captchaToken` on every gated call). Set it before enabling CAPTCHA protection in Supabase: AUTH.md "CAPTCHA (Turnstile)" |

**Client (Next.js):** `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLIC_KEY` (and the optional `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, as above). With `createBrowserClient` the generated `src/proxy.next.ts` reads them too: it verifies authenticated page requests (`getUser()` for documents, local `getClaims()` for RSC soft navigations and prefetches) and refreshes expired sessions as needed (`refreshSupabaseSession` from `@donotdev/supabase/server`). It throws without these env vars.

**On-demand revalidation (Next.js):** the build generates `src/app/api/dndev/revalidate/route.next.ts` (POST). A Supabase database webhook on each watched table (insert, update, delete) calls it with the header `Authorization: Bearer <DNDEV_REVALIDATE_SECRET>`; `readDatabaseWebhook` reads the body (`{ type, table, schema, record, old_record }`) and the cached pages showing the row are invalidated in every language: its entity pages (route `meta.entity` = table: the collection of the entity the page declares in PageMeta, new and old param value), every static page, `/sitemap.xml`, `/llms.txt`. Not covered: entity pages listing another table's rows (a brand page's products) and dynamic routes without an entity; they refresh on `appConfig.revalidate`. Put the webhook on public content tables only (tables of the `public` schema whose rows public pages show): every call invalidates all static pages, so a webhook on orders, carts or other high-write tables re-renders the whole site needlessly; a table outside `public` is refused (400). `DNDEV_REVALIDATE_SECRET` unset or shorter than 32 characters: every call fails (500). Server env only, never `NEXT_PUBLIC_`.

**Server (Edge Functions, API routes):** use the same URL and `SUPABASE_SECRET_KEY` for admin operations. Never expose the service_role key to the client. Put it in `.dndev.secrets` at project root (or your host's env for production).

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Project URL (set automatically by Supabase) |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin key (set automatically by Supabase) |
| `SUPABASE_ANON_KEY` | Public key (set automatically by Supabase) |
| `ALLOWED_ORIGIN` | CORS origin for edge functions (default: `*`). Set to your frontend URL in production for credentialed requests (e.g. `https://myapp.com`) |

---

## Hosting the Frontend

Supabase provides **Auth, PostgreSQL, Storage, and Edge Functions**. It does **not** host your built frontend.

**Recommended: Vercel** - see the VERCEL guideline.

```bash
dndev deploy
```

For Supabase projects, `dndev deploy` deploys frontend to Vercel (via scaffolded `vercel.json`) and Edge Functions to Supabase. Make sure you've set `VITE_SUPABASE_*` in Vercel Dashboard > Environment Variables.

---

## Local Development

**Against hosted Supabase:**

```bash
dndev dev
```

The app talks to your Supabase project directly.

**Local emulation:**

```bash
dndev emu start
```

Or install the [Supabase CLI](https://supabase.com/docs/guides/cli) and run `supabase start` for a local Postgres + Auth + Storage stack. Point `VITE_SUPABASE_URL` and keys to the local instance.

---

## Troubleshooting

**"Table not found" / "relation does not exist"**
- Run `dndev setup` - it generates SQL and pushes via Management API. Or copy the SQL from `supabase/migrations/` into the Dashboard SQL Editor.

**"Permission denied" / RLS errors**
- Check RLS policies in Supabase Dashboard > Database > Policies
- Generated migrations include default policies - verify they were applied

**"Service role key" errors in functions**
- Put `SUPABASE_SECRET_KEY` in `.dndev.secrets` at project root (never in `VITE_*` vars)
- Get it from Supabase Dashboard > Settings > API

---

**`dndev coach` > fill `.env` + `.dndev.secrets` > `dndev setup` > `dndev dev`. The adapter normalizes everything automatically.**
