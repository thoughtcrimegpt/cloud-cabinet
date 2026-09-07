import { createRemoteJWKSet, jwtVerify } from 'jose';
export type User = { email: string; isOwner: boolean };
export function configured(env: Env) {
  return (
    /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(
      env.ACCESS_TEAM_DOMAIN || '',
    ) &&
    /^[a-fA-F0-9]{64}$/.test(env.ACCESS_AUD || '') &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.OWNER_EMAIL || '')
  );
}
export async function authenticate(
  request: Request,
  env: Env,
): Promise<User | null> {
  if (!configured(env)) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16384) return null;
  try {
    const jwks = createRemoteJWKSet(
      new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
      { timeoutDuration: 5000 },
    );
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
      maxTokenAge: '24h',
    });
    if (typeof payload.email !== 'string' || !payload.email.includes('@'))
      return null;
    const email = payload.email.trim().toLowerCase();
    return { email, isOwner: email === env.OWNER_EMAIL.trim().toLowerCase() };
  } catch {
    return null;
  }
}
export function validMutation(request: Request) {
  // Browser requests cannot supply an arbitrary Origin header. No ambient-cookie
  // writes are accepted without an exact same-origin check.
  return request.headers.get('Origin') === new URL(request.url).origin;
}
