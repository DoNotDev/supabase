# Callable Provider

**When to use `callable.call<TReq, TRes>()` vs direct Supabase client.**

---

## Edge Function Calls → callable

Any call to a Supabase Edge Function MUST go through the callable provider:

```typescript
import { getProvider } from '@donotdev/core';

const callable = getProvider('callable');
const result = await callable.call<{ projectId: string }, QuoteResponse>(
  'compute-quote',
  { projectId },
);
```

### Why

- **Type safety:** `call<TReq, TRes>()` gives typed input AND output. Raw `.invoke()` returns `{ data: unknown }`.
- **Provider-agnostic:** Works across Firebase, Supabase, Vercel. No SDK lock-in.
- **Real Promise:** Raw Supabase `.from()` queries return `PromiseLike` (no `.catch()`, no `.finally()`). Callable returns real `Promise`.
- **Error handling:** Throws `DoNotDevError` with structured context. No manual `if (error)` destructuring.

### Pattern

```typescript
// One callable per function scope, not per call
const callable = getProvider('callable');

// Typed: compiler catches wrong payload shape
const data = await callable.call<RequestType, ResponseType>('function-name', payload);

// Errors throw — no destructure-and-check boilerplate
```

---

## Table Reads → direct client

Direct `supabaseClient.from('table').select()` is correct for table reads. No edge function round-trip needed.

```typescript
// Correct: direct table read
const { data } = await supabaseClient.from('projects').select('id, name');

// WRONG: edge function for a simple read
await callable.call('crud', { action: 'read', table: 'projects' });
```

---

## Realtime → direct client

Supabase Realtime subscriptions use the client SDK directly (channels, `postgres_changes`). The callable provider is for request/response, not subscriptions.

---

## AI Functions → callAIFunction

AI edge functions with retry/Sentry semantics use `callAIFunction()` from `utils/callAIFunction.ts`. This wrapper adds exponential backoff, structured error codes, and Sentry reporting — concerns beyond what callable provides.

---

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `supabaseClient.functions.invoke('fn', { body })` | `callable.call<TReq, TRes>('fn', body)` |
| `data as ResponseType` after `.invoke()` | Generic `call<TReq, TRes>()` — no cast |
| `const { data, error } = await ...invoke()` | `const data = await callable.call()` — errors throw |
| Edge function for simple table read | `supabaseClient.from('table').select()` |
