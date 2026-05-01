# @donotdev/supabase

Supabase provider for DoNotDev: CRUD, auth, storage, and server auth adapters. Use this package when you want to run a DoNotDev app on Supabase instead of Firebase.

---

## Complete Supabase Setup

### Prerequisites

1. Create a Supabase project at [supabase.com/dashboard](https://supabase.com/dashboard)
2. From **Settings > API**, copy:
   - **Project URL** (`https://xxx.supabase.co`)
   - **Public key** (`sb_publishable_...` or legacy anon key `eyJ...`)
   - **Secret key** (`sb_secret_...` or legacy service_role key)
3. From **Settings > Database**, copy:
   - **Connection string (URI)** (`postgresql://postgres.[ref]:[password]@...`)

Then run `dndev setup supabase` — it handles the rest.

### What `dndev setup supabase` does

| Step | Needs keys? | What it does |
|------|-------------|--------------|
| Write client `.env` | Public key only | `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLIC_KEY` |
| Generate entity SQL | No | Tables, RLS policies, triggers from entity definitions |
| Generate `providers.ts` | No | Supabase client init file |
| Run framework migrations | Secret key | Creates `idempotency`, `rate_limits`, `operation_metrics` tables |
| Apply entity migrations | CLI or manual | Push generated SQL to live database |
| Deploy edge functions | CLI | CRUD + custom claims functions |

---

## Setup Checklist

### 1. Database (FREE — automated by `dndev setup supabase`)

Everything below is generated from entity definitions. No manual SQL needed.

- [x] **Tables** — one per entity, columns from field definitions
- [x] **RLS policies** — derived from entity `access` config (`read`, `create`, `update`, `delete`)
- [x] **Status filtering** — `draft`/`deleted` rows hidden from non-admin in SELECT policies
- [x] **Triggers** — `updated_at` auto-set on UPDATE
- [x] **Framework tables** — `idempotency`, `rate_limits`, `operation_metrics`

**Extensions** (add to first migration if needed):
```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
```

### 2. Auth (FREE)

#### Automated by framework
- [x] **Email/password sign-up** — works out of the box
- [x] **Custom claims** — edge functions for `set-custom-claims`, `get-custom-claims`, `remove-custom-claims`
- [x] **Role hierarchy** — `guest < user < admin < super` stored in `app_metadata.role`

#### One-time Dashboard setup (Settings > Auth)
- [ ] **Site URL** — set to your production domain (e.g. `https://myapp.com`)
- [ ] **Redirect URLs** — add:
  - `http://localhost:5173` (Vite dev)
  - `http://localhost:3000` (Next.js dev)
  - `https://myapp.com` (production)
  - `https://*.vercel.app` (preview deploys, if using Vercel)
- [ ] **Email templates** — customize confirmation, invite, magic link, password reset (Settings > Auth > Email Templates). Works with defaults but branded templates are better UX.
- [ ] **Rate limits** — defaults are fine for most apps. Tighten if needed (Settings > Auth > Rate Limits).

#### OAuth providers (optional, FREE)
Each provider needs a client ID + secret from the provider's developer console, then paste into Supabase Dashboard > Auth > Providers.

| Provider | Get credentials from |
|----------|---------------------|
| Google | [console.cloud.google.com](https://console.cloud.google.com) > APIs & Services > Credentials |
| GitHub | [github.com/settings/developers](https://github.com/settings/developers) > OAuth Apps |
| Apple | [developer.apple.com](https://developer.apple.com) > Certificates, Identifiers & Profiles |
| Facebook | [developers.facebook.com](https://developers.facebook.com) > My Apps |

Set the **callback URL** shown in the Supabase Dashboard as the redirect URI in each provider's console.

### 3. Storage (FREE — 1 GB included)

#### What to automate (TODO — not yet in `dndev setup supabase`)
Storage buckets should be auto-created from entity field types. Any entity with `image`, `images`, `file`, `files`, `document`, or `documents` fields needs a storage bucket.

**Default bucket structure:**
```
uploads/          → default bucket (public or private per entity access)
  {collection}/   → folder per entity (e.g. uploads/apartments/)
    {id}/         → folder per document
```

**SQL to create buckets + policies** (should be generated):
```sql
-- Public bucket (for entities with read: 'guest')
INSERT INTO storage.buckets (id, name, public) VALUES ('uploads', 'uploads', true)
ON CONFLICT (id) DO NOTHING;

-- Upload policy: authenticated users can upload
CREATE POLICY "auth_upload" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (bucket_id = 'uploads');

-- Read policy: public access (matches entity read: 'guest')
CREATE POLICY "public_read" ON storage.objects FOR SELECT
  USING (bucket_id = 'uploads');

-- Delete policy: owner or admin can delete
CREATE POLICY "owner_delete" ON storage.objects FOR DELETE
  TO authenticated USING (
    bucket_id = 'uploads' AND (
      auth.uid()::text = (storage.foldername(name))[2]
      OR (auth.jwt()->'app_metadata'->>'role') IN ('admin', 'super')
    )
  );
```

### 4. Edge Functions (FREE — 500K invocations/month)

#### Deployed by `dndev setup supabase`
- [x] **CRUD function** — server-side CRUD with schema validation + HIDDEN_STATUSES enforcement
- [x] **Custom claims functions** — `set-custom-claims`, `get-custom-claims`, `remove-custom-claims`

#### Function secrets
After deploying, set secrets via CLI:
```bash
supabase secrets set SUPABASE_SECRET_KEY=sb_secret_...
```

Or via `dndev sync-secrets --target supabase`.

### 5. Realtime (FREE — included)

#### What to automate (TODO — not yet in `dndev setup supabase`)
Entities using `subscribeToCollection` or `subscribe` need their tables added to the Supabase realtime publication:

```sql
-- Enable realtime on specific tables
ALTER PUBLICATION supabase_realtime ADD TABLE apartments;
ALTER PUBLICATION supabase_realtime ADD TABLE inquiries;
```

This should be auto-generated for any entity whose CRUD hooks use subscriptions.

### 6. Client Config (automated by `dndev setup supabase`)

- [x] `.env` with public URL + key
- [x] `providers.ts` with Supabase client init + `configureProviders()`

---

## What's FREE vs PAID

| Feature | Free tier | Limit |
|---------|-----------|-------|
| Database | Yes | 500 MB storage, 2 GB egress/month |
| Auth | Yes | 50,000 MAU |
| Storage | Yes | 1 GB storage, 2 GB egress/month |
| Edge Functions | Yes | 500K invocations/month |
| Realtime | Yes | Included |
| Custom domains | No | Pro plan ($25/mo) |
| Daily backups | No | Pro plan |
| No project pausing | No | Pro plan (free tier pauses after 7 days inactivity) |
| SLA | No | Team plan ($599/mo) |

Everything DoNotDev generates and configures uses free-tier features only. Paid features are never assumed or required.

---

## TODO — Framework Automation Gaps

These are not yet automated by `dndev setup supabase` but should be:

| Gap | Priority | Approach |
|-----|----------|----------|
| Storage buckets from entity fields | High | Scan entities for file/image fields → generate bucket SQL |
| Storage RLS policies | High | Mirror entity `access` config to storage policies |
| Realtime publication | Medium | Detect subscription usage → generate `ALTER PUBLICATION` SQL |
| Auth redirect URLs | Low | Set via Management API (needs access token, not service role) |
| Email templates | Low | Ship branded defaults as HTML templates |

---

## Usage

### Client

```ts
import { createClient } from '@supabase/supabase-js';
import { configureProviders } from '@donotdev/core';
import {
  SupabaseCrudAdapter,
  SupabaseStorageAdapter,
  SupabaseAuth,
} from '@donotdev/supabase';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLIC_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY
);

configureProviders({
  crud: new SupabaseCrudAdapter(supabase),
  auth: new SupabaseAuth(supabase),
  storage: new SupabaseStorageAdapter(supabase, 'your-bucket'),
});
```

### Server

```ts
import {
  createServerClient,
  SupabaseServerAuthAdapter,
} from '@donotdev/supabase/server';
import { SupabaseCrudAdapter } from '@donotdev/supabase';

const supabase = createServerClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!
);

configureProviders({
  crud: new SupabaseCrudAdapter(supabase),
  serverAuth: new SupabaseServerAuthAdapter(supabase),
});
```

## Exports

- **Client (`@donotdev/supabase`):** `SupabaseCrudAdapter`, `SupabaseStorageAdapter`, `SupabaseAuth`
- **Server (`@donotdev/supabase/server`):** `SupabaseServerAuthAdapter`, `createServerClient`

## What Works

| Feature | Status |
|---------|--------|
| CRUD (create, read, update, delete) | Full support, schema validation via valibot |
| Query with filters, ordering, pagination | Full support (all operators) |
| Real-time subscriptions (document + collection) | Full support via Supabase channels |
| Auth (email/password, OAuth, magic link) | Full support |
| OAuth partners (Google, GitHub, Facebook, Apple, etc.) | Full support (14+ providers) |
| Storage (upload, delete, get URL) | Full support |
| Server auth (token verification, custom claims) | Full support |
| Account linking | Supported via `linkIdentity()` |
| Field-level visibility | Adapter selects only visible columns per role |
| Hidden status filtering | RLS blocks draft/deleted from non-admin SELECT |

## Known Limitations

### Auth Methods

| Method | Behavior | Workaround |
|--------|----------|------------|
| `deleteAccount()` | Requires `callable` provider + `delete-account` edge function (both auto-configured by `dndev setup supabase`) | N/A — works out of the box |
| `signInWithGoogleCredential()` | Returns `null` | Use `signInWithPartner('google')` for standard OAuth flow |
| `reauthenticateWithProvider()` | Triggers full OAuth redirect | Works but navigates away from page (no popup) |

### Framework Components (Firebase-Only)

| Feature | Status |
|---------|--------|
| `EmailPasswordForm` component | Works with Supabase (provider-neutral via `useAuth()`) |
| `useStripeBilling` | Works with Supabase (provider-neutral wrapper) |
| `FirebaseSmartRecovery` | Firebase-only (not needed for Supabase) |
| `FirebaseAccountLinking` | Firebase-only — use `SupabaseAuth.linkWithPartner()` directly |

### CLI Commands

| Command | Supabase support |
|---------|-----------------|
| `dndev emu` | Supported — runs `supabase start` (Docker-based local dev) |
| `dndev deploy` | Supported — Vercel frontend deploy via `vercel.json` detection |
| `dndev sync-secrets` (Firebase target) | Use `dndev sync-secrets --target github` for CI/CD secrets |

## License

See [LICENSE.md](./LICENSE.md).
