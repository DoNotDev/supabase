// packages/providers/supabase/src/__tests__/storageContract.test.ts

/**
 * @fileoverview Contract tests for Supabase Storage Adapter (IStorageAdapter)
 * @description Verifies SupabaseStorageAdapter satisfies IStorageAdapter with a mocked client.
 * No network calls — mocks only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { IStorageAdapter, UploadOptions } from '@donotdev/core';

import { SupabaseStorageAdapter } from '../client/storageAdapter';

// =============================================================================
// Mock Supabase client (storage only)
// =============================================================================

function createMockSupabaseClient(options?: { uploadRejects?: boolean }) {
  const bucketRef = {
    upload: vi
      .fn()
      .mockImplementation((path: string) =>
        options?.uploadRejects
          ? Promise.reject(new Error('Storage quota exceeded'))
          : Promise.resolve({ data: { path }, error: null })
      ),
    getPublicUrl: vi.fn().mockImplementation((path: string) => ({
      data: {
        publicUrl: `https://mock.supabase.co/storage/v1/object/public/uploads/${path}`,
      },
    })),
    remove: vi.fn().mockResolvedValue({ error: null }),
  };

  const from = vi.fn().mockReturnValue(bucketRef);

  const mockStorage = {
    from,
  };

  return {
    storage: mockStorage,
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

// =============================================================================
// Contract tests
// =============================================================================

describe('SupabaseStorageAdapter — IStorageAdapter contract', () => {
  let client: ReturnType<typeof createMockSupabaseClient>;
  let adapter: SupabaseStorageAdapter;

  beforeEach(() => {
    client = createMockSupabaseClient();
    adapter = new SupabaseStorageAdapter(client, 'uploads');
  });

  it('satisfies IStorageAdapter type', () => {
    const typed: IStorageAdapter = adapter;
    expect(typed).toBeDefined();
    expect(typeof typed.upload).toBe('function');
    expect(typeof typed.delete).toBe('function');
    expect(typeof typed.getUrl).toBe('function');
  });

  it('upload() returns UploadResult with url and path', async () => {
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    const result = await adapter.upload(file);

    expect(result).toHaveProperty('url');
    expect(result).toHaveProperty('path');
    expect(typeof result.url).toBe('string');
    expect(typeof result.path).toBe('string');
    expect(result.url.length).toBeGreaterThan(0);
    expect(result.path.length).toBeGreaterThan(0);
  });

  it('upload() calls onProgress(0) and onProgress(100)', async () => {
    const file = new File(['data'], 'photo.png', { type: 'image/png' });
    const onProgress = vi.fn();
    const options: UploadOptions = { onProgress };

    await adapter.upload(file, options);

    expect(onProgress).toHaveBeenCalledWith(0);
    expect(onProgress).toHaveBeenCalledWith(100);
  });

  it('upload() respects storagePath and filename options', async () => {
    const file = new File(['data'], 'original.png', { type: 'image/png' });
    const result = await adapter.upload(file, {
      storagePath: 'avatars',
      filename: 'user-1.png',
    });

    expect(result.path).toContain('avatars');
    expect(result.path).toContain('user-1.png');
    expect(result.url).toContain(result.path);
  });

  it('delete() resolves without error (by path)', async () => {
    await expect(adapter.delete('uploads/file.txt')).resolves.toBeUndefined();
    expect(client.storage.from).toHaveBeenCalledWith('uploads');
  });

  it('getUrl() returns a non-empty string', async () => {
    const url = await adapter.getUrl('path/to/file.jpg');
    expect(typeof url).toBe('string');
    expect(url.length).toBeGreaterThan(0);
    expect(url).toContain('path/to/file.jpg');
  });

  it('upload() accepts Blob', async () => {
    const blob = new Blob(['blob content'], { type: 'text/plain' });
    const result = await adapter.upload(blob);
    expect(result.url).toBeTruthy();
    expect(result.path).toBeTruthy();
  });

  it('delete() by full public URL resolves without error', async () => {
    const publicUrl =
      'https://mock.supabase.co/storage/v1/object/public/uploads/avatars/user.png';
    await expect(adapter.delete(publicUrl)).resolves.toBeUndefined();
    expect(client.storage.from).toHaveBeenCalledWith('uploads');
  });

  it('upload() propagates storage error', async () => {
    const failingClient = createMockSupabaseClient({ uploadRejects: true });
    const failingAdapter = new SupabaseStorageAdapter(failingClient, 'uploads');
    const file = new File(['x'], 'x.txt');
    await expect(failingAdapter.upload(file)).rejects.toThrow();
  });
});
