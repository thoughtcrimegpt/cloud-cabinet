import { authenticate, configured, validMutation } from './auth.ts';
import { handleStorage } from './storage.ts';
import { handleSettings } from './settings.ts';
import { handleGmail } from './gmail.ts';
function secure(response: Response) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/setup' && request.method === 'GET')
        return secure(Response.json({ configured: configured(env) }));
      if (!url.pathname.startsWith('/api/'))
        return secure(await env.ASSETS.fetch(request));
      if (!configured(env))
        return secure(
          Response.json(
            {
              error:
                'Finish Cloudflare Access setup before using this library.',
            },
            { status: 503 },
          ),
        );
      const user = await authenticate(request, env);
      if (!user)
        return secure(
          Response.json(
            {
              error:
                'Sign in through this installation’s Cloudflare Access policy.',
            },
            { status: 401 },
          ),
        );
      if (!['GET', 'HEAD'].includes(request.method) && !validMutation(request))
        return secure(
          Response.json(
            { error: 'Request origin is not allowed.' },
            { status: 403 },
          ),
        );
      if (url.pathname === '/api/me' && request.method === 'GET')
        return secure(
          Response.json({
            ...user,
            maxStorageBytes: Number(env.MAX_STORAGE_BYTES) || 10000000000,
            maxUploadBytes: 20 * 1024 * 1024,
          }),
        );
      const result =
        (await handleSettings(request, env, user)) ||
        (await handleGmail(request, env, user)) ||
        (await handleStorage(request, env, user));
      return secure(
        result || Response.json({ error: 'Not found.' }, { status: 404 }),
      );
    } catch {
      // Provider exceptions can contain SQL, file names, request headers, or tokens.
      // Do not log or return them to the browser.
      return secure(
        Response.json(
          {
            error:
              'The request could not be completed. Check storage setup and try again.',
          },
          { status: 500 },
        ),
      );
    }
  },
} satisfies ExportedHandler<Env>;
