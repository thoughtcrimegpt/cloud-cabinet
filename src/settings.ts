import { validateCss } from './customization.ts';
import type { User } from './auth.ts';
export async function handleSettings(
  request: Request,
  env: Env,
  user: User,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/settings') return null;
  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT company_name AS companyName,accent_color AS accentColor,custom_css AS customCss FROM app_settings WHERE id=1',
    ).first();
    return Response.json(
      row || {
        companyName: 'Cloud Cabinet',
        accentColor: '#1430a3',
        customCss: '',
      },
    );
  }
  if (request.method !== 'PUT')
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  if (!user.isOwner)
    return Response.json(
      { error: 'Only the workspace owner can change branding.' },
      { status: 403 },
    );
  if (Number(request.headers.get('content-length') || 0) > 12000)
    return Response.json({ error: 'Settings are too large.' }, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader)
    return Response.json({ error: 'Settings are required.' }, { status: 400 });
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 12000) {
      await reader.cancel();
      return Response.json(
        { error: 'Settings are too large.' },
        { status: 413 },
      );
    }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof body.companyName !== 'string' ||
      !body.companyName.trim() ||
      body.companyName.length > 80 ||
      /[\u0000-\u001f<>]/.test(body.companyName)
    )
      throw new Error('Use a company name of 1 to 80 characters.');
    if (
      typeof body.accentColor !== 'string' ||
      !/^#[0-9a-fA-F]{6}$/.test(body.accentColor)
    )
      throw new Error('Choose a six-digit hex color.');
    const customCss = validateCss(body.customCss ?? '');
    await env.DB.prepare(
      'UPDATE app_settings SET company_name=?,accent_color=?,custom_css=? WHERE id=1',
    )
      .bind(body.companyName.trim(), body.accentColor, customCss)
      .run();
    return Response.json({
      companyName: body.companyName.trim(),
      accentColor: body.accentColor,
      customCss,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Invalid settings.' },
      { status: 400 },
    );
  }
}
