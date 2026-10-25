/**
 * Google service-account authentication. DENO-ONLY.
 *
 * Master Prompt §1: write to Sheets "using the official Google Sheets API
 * using a dedicated least-privilege Google Cloud service account... Never send
 * a Sheets API credential, service-account JSON, Google refresh token or
 * Supabase secret/service-role key to the browser."
 *
 * The flow is the standard two-legged OAuth JWT bearer grant:
 *   1. build a JWT asserting the service account's identity and the scope;
 *   2. sign it with the account's RSA private key (RS256);
 *   3. exchange it at the token endpoint for a short-lived access token.
 *
 * No refresh token exists in this flow, which is the point: there is no
 * long-lived bearer credential to leak, and revoking the service account
 * revokes everything immediately.
 *
 * Scope is exactly `https://www.googleapis.com/auth/spreadsheets` — not
 * `drive`, not `drive.file`. The service account can therefore read and write
 * only the spreadsheets that have been shared with it by hand, and cannot
 * enumerate, create or delete anything in Drive.
 */

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** Refresh this far before expiry so an in-flight request never 401s. */
const REFRESH_SKEW_MS = 120_000;

export interface ServiceAccount {
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri: string;
  readonly project_id: string | null;
}

export class GoogleAuthError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'GoogleAuthError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Parse the service-account JSON secret.
 *
 * Normalises `\n` sequences in the private key. A PEM carries real newlines,
 * but a key pasted through a shell, a CI variable editor or
 * `supabase secrets set` very often arrives with the newlines escaped. Without
 * this the only symptom is an opaque `importKey` failure, which is a bad way to
 * spend an afternoon.
 */
export function parseServiceAccount(json: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new GoogleAuthError(
      'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole downloaded key file, including the braces.',
      error,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new GoogleAuthError('GOOGLE_SERVICE_ACCOUNT_JSON must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  const clientEmail = record['client_email'];
  const privateKey = record['private_key'];
  if (typeof clientEmail !== 'string' || clientEmail === '') {
    throw new GoogleAuthError('GOOGLE_SERVICE_ACCOUNT_JSON is missing "client_email".');
  }
  if (typeof privateKey !== 'string' || privateKey === '') {
    throw new GoogleAuthError('GOOGLE_SERVICE_ACCOUNT_JSON is missing "private_key".');
  }
  const tokenUri = record['token_uri'];
  const projectId = record['project_id'];
  return {
    client_email: clientEmail,
    private_key: privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey,
    token_uri: typeof tokenUri === 'string' && tokenUri !== '' ? tokenUri : DEFAULT_TOKEN_URI,
    project_id: typeof projectId === 'string' ? projectId : null,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlText(text: string): string {
  return base64Url(new TextEncoder().encode(text));
}

/**
 * The DER bytes of a PKCS#8 "BEGIN PRIVATE KEY" block, as a non-shared
 * `ArrayBuffer`.
 *
 * The return type is `ArrayBuffer` rather than `Uint8Array` on purpose.
 * `crypto.subtle.importKey`'s non-JWK overload takes a `BufferSource`, whose
 * view arm is `ArrayBufferView<ArrayBuffer>` — a view whose backing store is
 * specifically NOT a `SharedArrayBuffer`. A bare `Uint8Array` annotation widens
 * to `Uint8Array<ArrayBufferLike>`, which admits a shared backing store and so
 * does not satisfy that overload. Handing back the freshly allocated buffer
 * states the fact that is already true here — these bytes were just built by
 * this function and nothing else holds them — instead of asserting it with a
 * cast that would also silence a genuine mismatch later.
 */
function pkcs8Bytes(pem: string): ArrayBuffer {
  const body = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  if (body === '') {
    throw new GoogleAuthError('The service-account private key is empty.');
  }
  let binary: string;
  try {
    binary = atob(body);
  } catch (error) {
    throw new GoogleAuthError(
      'The service-account private key is not valid base64. It must be the PKCS#8 "BEGIN PRIVATE KEY" block from the downloaded key file.',
      error,
    );
  }
  // `new ArrayBuffer(n)` is never shared, so the view below is inferred as
  // `Uint8Array<ArrayBuffer>` and `buffer` keeps that exact type.
  const buffer = new ArrayBuffer(binary.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return buffer;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

export class GoogleTokenProvider {
  private key: CryptoKey | null = null;
  private cached: CachedToken | null = null;
  /** In-flight refresh, so a burst of calls mints one token, not twenty. */
  private pending: Promise<string> | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly scope: string = SHEETS_SCOPE,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get clientEmail(): string {
    return this.account.client_email;
  }

  private async signingKey(): Promise<CryptoKey> {
    if (this.key !== null) return this.key;
    try {
      this.key = await crypto.subtle.importKey(
        'pkcs8',
        pkcs8Bytes(this.account.private_key),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      );
    } catch (error) {
      if (error instanceof GoogleAuthError) throw error;
      throw new GoogleAuthError(
        'The service-account private key could not be imported. It must be an unencrypted PKCS#8 RSA key.',
        error,
      );
    }
    return this.key;
  }

  private async buildAssertion(nowMs: number): Promise<string> {
    const issuedAt = Math.floor(nowMs / 1000);
    const header = base64UrlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64UrlText(
      JSON.stringify({
        iss: this.account.client_email,
        scope: this.scope,
        aud: this.account.token_uri,
        iat: issuedAt,
        // One hour is the maximum Google accepts for this grant.
        exp: issuedAt + 3600,
      }),
    );
    const signingInput = `${header}.${claims}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      await this.signingKey(),
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  }

  private async exchange(nowMs: number): Promise<CachedToken> {
    const assertion = await this.buildAssertion(nowMs);
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    const response = await this.fetchImpl(this.account.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      // Google's error body names the problem ("invalid_grant") without
      // echoing the key, so it is safe to surface. The assertion is not.
      const detail = await response.text().catch(() => '');
      throw new GoogleAuthError(
        `Google refused the service-account assertion (HTTP ${response.status}). ${detail.slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    const token = payload.access_token;
    if (typeof token !== 'string' || token === '') {
      throw new GoogleAuthError('Google returned no access token.');
    }
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
    return { token, expiresAtMs: nowMs + expiresIn * 1000 };
  }

  async getAccessToken(nowMs: number = Date.now()): Promise<string> {
    const cached = this.cached;
    if (cached !== null && cached.expiresAtMs - REFRESH_SKEW_MS > nowMs) {
      return cached.token;
    }
    if (this.pending !== null) return await this.pending;

    this.pending = (async () => {
      try {
        const fresh = await this.exchange(nowMs);
        this.cached = fresh;
        return fresh.token;
      } finally {
        this.pending = null;
      }
    })();
    return await this.pending;
  }

  /** Drop the cached token, e.g. after a 401 from the Sheets API. */
  invalidate(): void {
    this.cached = null;
  }
}
