// packages/providers/supabase/src/client/storageAdapter.ts

/**
 * @fileoverview Supabase Storage Adapter
 * @description IStorageAdapter implementation using Supabase Storage.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type {
  IStorageAdapter,
  UploadOptions,
  UploadResult,
} from '@donotdev/core';
import { wrapStorageError } from '@donotdev/core';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase Storage adapter implementing IStorageAdapter.
 *
 * Bucket is set once at construction (required). `storagePath` in upload
 * options is an optional folder prefix within the bucket.
 *
 * @version 0.3.0
 * @since 0.0.1
 */
export class SupabaseStorageAdapter implements IStorageAdapter {
  constructor(
    private readonly client: SupabaseClient,
    private readonly bucket: string
  ) {}

  async upload(
    file: File | Blob,
    options?: UploadOptions
  ): Promise<UploadResult> {
    if (options?.signal?.aborted) {
      throw wrapStorageError(
        new Error('Upload cancelled'),
        'SupabaseStorageAdapter',
        'upload',
        ''
      );
    }
    try {
      options?.onProgress?.(0);
      const ext =
        file instanceof File && file.name?.includes('.')
          ? file.name.slice(file.name.lastIndexOf('.'))
          : '';
      const filename =
        options?.filename ??
        `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
      const uploadPath = options?.storagePath
        ? `${options.storagePath}/${filename}`
        : filename;

      const { data, error } = await this.client.storage
        .from(this.bucket)
        .upload(uploadPath, file, { upsert: true });

      if (error)
        throw wrapStorageError(
          error,
          'SupabaseStorageAdapter',
          'upload',
          uploadPath
        );
      if (!data)
        throw wrapStorageError(
          new Error('Upload returned no data'),
          'SupabaseStorageAdapter',
          'upload',
          uploadPath
        );

      options?.onProgress?.(100);
      const {
        data: { publicUrl },
      } = this.client.storage.from(this.bucket).getPublicUrl(data.path);
      return {
        url: publicUrl,
        path: data.path,
      };
    } catch (error) {
      throw wrapStorageError(
        error,
        'SupabaseStorageAdapter',
        'upload',
        options?.storagePath || ''
      );
    }
  }

  async delete(
    urlOrPath: string,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    if (options?.signal?.aborted) {
      throw wrapStorageError(
        new Error('Delete cancelled'),
        'SupabaseStorageAdapter',
        'delete',
        urlOrPath
      );
    }
    try {
      const path: string = urlOrPath.startsWith('http')
        ? this.pathFromUrl(urlOrPath)
        : urlOrPath;
      const { error } = await this.client.storage
        .from(this.bucket)
        .remove([path]);
      if (error)
        throw wrapStorageError(error, 'SupabaseStorageAdapter', 'delete', path);
    } catch (error) {
      throw wrapStorageError(
        error,
        'SupabaseStorageAdapter',
        'delete',
        urlOrPath
      );
    }
  }

  async getUrl(path: string): Promise<string> {
    const {
      data: { publicUrl },
    } = this.client.storage.from(this.bucket).getPublicUrl(path);
    return publicUrl;
  }

  private pathFromUrl(url: string): string {
    try {
      const u = new URL(url);

      // Try multiple patterns to extract path
      // Pattern 1: /storage/v1/object/public/{bucket}/{path}
      let match = u.pathname.match(
        /\/storage\/v1\/object\/public\/[^/]+\/(.+)/
      );
      if (match && match[1] != null) {
        return decodeURIComponent(match[1]);
      }

      // Pattern 2: /storage/v1/object/sign/{bucket}/{path} (signed URLs)
      match = u.pathname.match(/\/storage\/v1\/object\/sign\/[^/]+\/(.+)/);
      if (match && match[1] != null) {
        return decodeURIComponent(match[1]);
      }

      // Pattern 3: Custom domain/CDN - try to extract from pathname directly
      // If pathname looks like a file path, use it
      if (
        u.pathname &&
        u.pathname.length > 1 &&
        !u.pathname.startsWith('/api/')
      ) {
        return decodeURIComponent(u.pathname.slice(1)); // Remove leading /
      }

      // Fallback: return original URL if we can't parse it
      return url;
    } catch {
      // If URL parsing fails, return original
      return url;
    }
  }
}
