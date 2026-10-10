export function secureWebResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  const apiOrigin = new URL(import.meta.env.NEXT_PUBLIC_SERVER_URL).origin;
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  headers.set(
    'Content-Security-Policy',
    "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  );
  headers.set(
    'Content-Security-Policy-Report-Only',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self' ${apiOrigin} https://challenges.cloudflare.com`,
      `img-src 'self' blob: data: ${apiOrigin}`,
      "font-src 'self' data:",
      'frame-src https://challenges.cloudflare.com',
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  if (headers.get('Content-Type')?.includes('text/html')) {
    headers.set('Cache-Control', 'private, no-store');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
