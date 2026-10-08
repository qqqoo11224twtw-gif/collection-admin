// Test-only external Telegram HTTP service. Never connects to Telegram.
export default {
  async fetch(request) {
    if (new URL(request.url).hostname !== 'api.telegram.org')
      return new Response('Unexpected test origin', { status: 500 });
    const input = await request.json();
    switch (input.text) {
      case 'invalid-json':
        return new Response('<html>unavailable</html>');
      case 'null-json':
        return Response.json(null);
      case 'missing-id':
        return Response.json({ ok: true, result: {} });
      case 'rate-limit':
        return Response.json(
          { ok: false, error_code: 429, parameters: { retry_after: 2 } },
          { status: 429 },
        );
      case 'server-error':
        return Response.json({ ok: false, error_code: 500 }, { status: 500 });
      case 'redirect':
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://example.invalid/never-follow' },
        });
      default:
        return Response.json({ ok: true, result: { message_id: 123 } });
    }
  },
};
