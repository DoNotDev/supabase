import { describe, expect, it, vi } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

import { SupabaseCrudAdapter } from '../client/crudAdapter';

/** JWT with the given claims (signature irrelevant: PostgREST verifies, not us). */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;
}

/** Minimal PostgREST builder chain recording headers. */
function fakeClient() {
  const headers: Array<[string, string]> = [];
  const result = { data: [], error: null, count: 0 };
  const builder: Record<string, unknown> = {};
  for (const m of ['eq', 'order', 'limit', 'gt', 'lt', 'select']) builder[m] = vi.fn(() => builder);
  builder.setHeader = vi.fn((name: string, value: string) => {
    headers.push([name, value]);
    return builder;
  });
  builder.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const getSession = vi.fn(async () => ({ data: { session: null } }));
  const client = {
    from: vi.fn(() => builder),
    auth: { getSession, onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) },
  } as unknown as SupabaseClient;
  return { client, headers, getSession };
}

describe('SupabaseCrudAdapter.forAccessToken', () => {
  it('sends the visitor token on reads; the shared adapter does not', async () => {
    const { client, headers } = fakeClient();
    const adapter = new SupabaseCrudAdapter(client);
    await adapter.query('brands', {});
    expect(headers).toEqual([]);

    const token = jwt({ app_metadata: { role: 'user' } });
    await adapter.forAccessToken(token).query('brands', {});
    expect(headers).toEqual([['Authorization', `Bearer ${token}`]]);

    await adapter.forAccessToken(token).get('brands', 'b1');
    expect(headers.at(-1)).toEqual(['Authorization', `Bearer ${token}`]);
  });

  it('takes the role from the token claims, not the shared session', async () => {
    const { client, getSession } = fakeClient();
    const view = new SupabaseCrudAdapter(client).forAccessToken(jwt({ app_metadata: { role: 'admin' } }));
    // getUserRole is private: its effect is that no session lookup happens.
    await view.query('brands', {}, { entries: {} } as never);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('a malformed token still reads as a signed-in user (the database rejects it)', async () => {
    const { client, headers } = fakeClient();
    await new SupabaseCrudAdapter(client).forAccessToken('not-a-jwt').query('brands', {});
    expect(headers).toEqual([['Authorization', 'Bearer not-a-jwt']]);
  });
});
