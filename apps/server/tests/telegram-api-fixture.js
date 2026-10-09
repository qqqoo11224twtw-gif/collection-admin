// Test-only external Telegram HTTP service. Never connects to Telegram.
export default {
  async fetch(request) {
    if (new URL(request.url).hostname !== 'api.telegram.org')
      return new Response('Unexpected test origin', { status: 500 });
    if (
      request.headers.get('content-type')?.startsWith('multipart/form-data')
    ) {
      const form = await request.formData();
      if (
        form.get('chat_id') !== '-1001234567890' ||
        form.get('message_thread_id') !== '2'
      )
        return Response.json({ ok: false, error_code: 400 }, { status: 400 });
      if (new URL(request.url).pathname.endsWith('/sendPhoto'))
        return Response.json({ ok: true, result: { message_id: 124 } });
      const media = JSON.parse(String(form.get('media')));
      if (
        media.some(
          (item) =>
            !(form.get(item.media.replace('attach://', '')) instanceof File),
        )
      )
        return Response.json({ ok: false, error_code: 400 }, { status: 400 });
      if (form.get('chat_id') && form.get('message_thread_id'))
        return Response.json({
          ok: true,
          result: media.map((_, i) => ({ message_id: 125 + i })),
        });
    }
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
