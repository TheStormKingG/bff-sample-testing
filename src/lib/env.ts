/**
 * Frontend configuration.
 *
 * ---------------------------------------------------------------------------
 * NOTHING SECRET MAY EVER BE ADDED TO THIS FILE OR TO ANY `VITE_*` VARIABLE.
 *
 * GitHub Pages is a public static host and every `VITE_*` value is inlined
 * into the published JavaScript bundle at build time, so each one is readable
 * by anybody with or without a login. The Supabase service-role key, the
 * Google service-account JSON or private key, the OAuth client secret, a
 * Google refresh token and the Sheets spreadsheet ID are Edge Function
 * secrets and must never appear here, in `index.html`, or anywhere under
 * `src/`. Master Prompt section 1; PRD NFR-002.
 *
 * The schema below is deliberately an allowlist of exactly four variables, so
 * adding a fifth is a visible, reviewable change rather than a quiet one.
 * ---------------------------------------------------------------------------
 */

import { z } from 'zod';

declare global {
  /**
   * `import.meta.env` is injected by Vite. The project's tsconfig does not
   * reference `vite/client`, so the shape is declared here instead — which has
   * the useful side effect of making an undeclared `VITE_*` read a type error.
   */
  interface ImportMeta {
    readonly env: {
      /** Vite `base`: '/' in local dev, '/<repo>/' on GitHub Pages. */
      readonly BASE_URL: string;
      readonly MODE: string;
      readonly DEV: boolean;
      readonly PROD: boolean;
      readonly VITE_SUPABASE_URL?: string;
      readonly VITE_SUPABASE_ANON_KEY?: string;
      readonly VITE_APP_VERSION?: string;
      readonly VITE_BASE_PATH?: string;
    };
  }
}

const envSchema = z.object({
  VITE_SUPABASE_URL: z
    .string({ required_error: 'VITE_SUPABASE_URL is not set' })
    .trim()
    .min(1, 'VITE_SUPABASE_URL is empty')
    .url('VITE_SUPABASE_URL must be a full URL, for example https://abc.supabase.co')
    .refine((v) => v.startsWith('https://'), {
      message: 'VITE_SUPABASE_URL must use https (PRD NFR-002 requires HTTPS-only)',
    }),

  VITE_SUPABASE_ANON_KEY: z
    .string({ required_error: 'VITE_SUPABASE_ANON_KEY is not set' })
    .trim()
    .min(1, 'VITE_SUPABASE_ANON_KEY is empty'),

  /** Shown in the footer so a record can be traced to the deployment. */
  VITE_APP_VERSION: z.string().trim().min(1).default('unknown'),

  /**
   * Recorded for diagnostics only. Routing uses `import.meta.env.BASE_URL`,
   * which Vite derives from `base` at build time, so the two cannot disagree
   * at runtime even if this variable is stale.
   */
  VITE_BASE_PATH: z.string().trim().min(1).default('/'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Validate and return the frontend configuration.
 *
 * Throws a single readable error listing every problem. `main.tsx` calls this
 * before rendering anything, so a misconfigured deployment produces a legible
 * message instead of a blank page (PRD section 11: keep failures
 * understandable).
 */
export function readEnv(): Env {
  if (cached !== null) return cached;

  const result = envSchema.safeParse({
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
    VITE_APP_VERSION: import.meta.env.VITE_APP_VERSION,
    VITE_BASE_PATH: import.meta.env.VITE_BASE_PATH,
  });

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      'BFF Sample Testing cannot start: the frontend configuration is incomplete.\n' +
        problems +
        '\n\nCopy .env.example to .env and fill in the Supabase project URL and ' +
        'publishable (anon) key. Never add a secret to a VITE_ variable.',
    );
  }

  cached = result.data;
  return cached;
}

/** Validated configuration. Reading this member triggers validation. */
export const env: Env = readEnv();

/** Vite's compiled base path. Used for the OAuth redirect and asset URLs. */
export const basePath: string = import.meta.env.BASE_URL;
