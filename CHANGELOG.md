# @donotdev/supabase

## Unreleased

### Patch Changes

- CAPTCHA (Turnstile): every call Supabase Auth gates with CAPTCHA protection sends `options.captchaToken` from `getCaptchaToken()` (`@donotdev/core`), one fresh token per call: `signInWithEmail` / `signInWithEmailAndPassword` and `reauthenticateWithPassword` (`signInWithPassword`), `createUserWithEmail` (`signUp`), `sendPasswordResetEmail` (`resetPasswordForEmail`), `sendEmailVerification` (`resend`), `sendSignInLinkToEmail` (`signInWithOtp`). Not gated, no token: `verifyEmailCode` / `verifyOtp`, OAuth, `updateUser`, refresh. Without `TURNSTILE_SITE_KEY` nothing is sent; a token failure rejects with `details.originalCode` `captcha_failed` before the call goes out.
- `SupabaseAuth.listUsers()`: every auth account (admin apps) through the callable provider and the app's `list-auth-users` edge function (`createListAuthUsers`); without a callable provider it throws with `details.originalCode` `LIST_USERS_REQUIRES_SERVER`.
- `SupabaseAuth.refreshToken()` no longer throws when Supabase discards the refresh (`AuthRefreshDiscardedError`, auth-js: another refresh, from another tab or the proxy rewriting the session cookie, or a sign-out changed the stored session during this one). auth-js treats that as a no-op; it surfaced to apps as a refresh failure. The stored session is applied and its access token returned, `null` when it was a sign-out.
- New `SupabasePublicReader` (`@donotdev/supabase/server`): the public reader of the framework's record readers (generated sitemap.xml, llms.txt and entity pages, Vite record pages; was a plain `SupabaseCrudAdapter`). Its `query` reads every column RLS returns to a signed-out visitor (`select=*`), keyed by the entity's field names from the schema (`availability_date` stays `availability_date`), with no role-based column choice or visibility filter: technical `status` / `updatedAt` keep feeding availability and `lastmod`. `SupabaseCrudAdapter.query` is unchanged (its role path moved to the protected `queryAs`).

## 0.1.43

### Patch Changes

- 6b68659: Fix OAuth popup flow not completing in dev: add missing redirectTo so the popup returns to the current origin instead of the production Site URL
- Updated dependencies [98d641c]
- Updated dependencies [a4c57d7]
  - @donotdev/core@0.1.43
