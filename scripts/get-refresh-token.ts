import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import Fastify from 'fastify';

const SIGNIN_URL = process.env.TRADESTATION_SIGNIN_URL || 'https://signin.tradestation.com';
const AUDIENCE = 'https://api.tradestation.com';
const SCOPE = 'openid profile offline_access MarketData ReadAccount Trade';
const REDIRECT_PORT = Number(process.env.OAUTH_REDIRECT_PORT) || 3001;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;
const TIMEOUT_MS = 5 * 60 * 1000;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function main() {
  const clientId = process.env.TRADESTATION_CLIENT_ID;
  const clientSecret = process.env.TRADESTATION_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      'Missing TRADESTATION_CLIENT_ID or TRADESTATION_CLIENT_SECRET. ' +
        'Set them in .env before running this script.',
    );
    process.exit(1);
  }

  const state = randomBytes(16).toString('hex');
  const authorizeUrl =
    `${SIGNIN_URL}/authorize?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      audience: AUDIENCE,
      scope: SCOPE,
      state,
    }).toString();

  const server = Fastify({ logger: false });
  let resolved = false;

  const finish = async (code: number) => {
    if (resolved) return;
    resolved = true;
    try {
      await server.close();
    } catch {
      // ignore
    }
    process.exit(code);
  };

  server.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/',
    async (request, reply) => {
      const { code, state: returnedState, error, error_description } = request.query;

      if (error) {
        const msg = `${error}: ${error_description ?? ''}`;
        console.error('[oauth] authorize error:', msg);
        reply.type('text/html').send(`<h1>Auth error</h1><pre>${msg}</pre>`);
        setImmediate(() => finish(1));
        return;
      }

      if (!code) {
        reply.status(400).type('text/html').send('<h1>Missing code</h1>');
        setImmediate(() => finish(1));
        return;
      }

      if (returnedState !== state) {
        console.error('[oauth] state mismatch — possible CSRF. Aborting.');
        reply.status(400).type('text/html').send('<h1>State mismatch</h1>');
        setImmediate(() => finish(1));
        return;
      }

      try {
        const tokens = await exchangeCodeForTokens({ code, clientId, clientSecret });
        if (!tokens.refresh_token) {
          console.error('[oauth] token response missing refresh_token. Full body:', tokens);
          reply.status(500).type('text/html').send('<h1>No refresh_token in response</h1>');
          setImmediate(() => finish(1));
          return;
        }

        console.log('\n=== TradeStation tokens ===');
        console.log(`access_token  (preview): ${tokens.access_token?.slice(0, 20)}...`);
        console.log(`expires_in:              ${tokens.expires_in}s`);
        console.log(`refresh_token:           ${tokens.refresh_token}`);
        console.log('\nPaste the refresh_token into .env as TRADESTATION_REFRESH_TOKEN=<value>\n');

        reply.type('text/html').send(
          '<h1>Token obtenido</h1><p>Ya puedes cerrar esta ventana y volver a la terminal.</p>',
        );
        setImmediate(() => finish(0));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[oauth] token exchange failed:', message);
        reply.status(500).type('text/html').send(`<h1>Exchange failed</h1><pre>${message}</pre>`);
        setImmediate(() => finish(1));
      }
    },
  );

  await server.listen({ port: REDIRECT_PORT, host: '127.0.0.1' });

  console.log(`[oauth] Listening on ${REDIRECT_URI}`);
  console.log('[oauth] Open this URL in your browser if it does not open automatically:\n');
  console.log(authorizeUrl);
  console.log('');

  exec(`open "${authorizeUrl}"`, (err) => {
    if (err) {
      console.warn('[oauth] could not auto-open browser:', err.message);
    }
  });

  setTimeout(() => {
    console.error(`[oauth] Timeout after ${TIMEOUT_MS / 1000}s without callback. Aborting.`);
    finish(1);
  }, TIMEOUT_MS).unref();
}

async function exchangeCodeForTokens({
  code,
  clientId,
  clientSecret,
}: {
  code: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch(`${SIGNIN_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await res.text();
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`Non-JSON response from /oauth/token (HTTP ${res.status}): ${text}`);
  }

  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} ${parsed.error ?? ''} ${parsed.error_description ?? text}`,
    );
  }

  return parsed;
}

main().catch((err) => {
  console.error('[oauth] fatal:', err);
  process.exit(1);
});
