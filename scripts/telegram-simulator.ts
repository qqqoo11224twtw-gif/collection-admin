import {
  photoFixture,
  reportFixture,
} from '../packages/api/src/telegram-fixtures.ts';

// Send fictional updates only to the local receiver. Process them from the admin settings page.
const scenario = process.argv[2] ?? 'photo';
const chatId = Number(process.env.SIMULATOR_CHAT_ID ?? '-100900001');
const userId = Number(process.env.SIMULATOR_USER_ID ?? '900001');
const topicId = process.env.SIMULATOR_TOPIC_ID
  ? Number(process.env.SIMULATOR_TOPIC_ID)
  : undefined;
const secret =
  process.env.SIMULATOR_WEBHOOK_SECRET ?? 'local-simulator-placeholder';
const seed = Date.now();
const send = async (update: unknown) => {
  const response = await fetch('http://localhost:4000/api/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(update),
  });
  if (!response.ok) throw new Error(`Local simulator HTTP ${response.status}`);
  console.log(await response.json());
};
if (scenario === 'report')
  await send(
    reportFixture(
      seed,
      chatId,
      userId,
      process.argv[3] ?? 'FICTIONAL-A001',
      topicId,
    ),
  );
else if (scenario === 'album' || scenario === 'delayed-album') {
  for (let i = 0; i < 3; i++) {
    if (scenario === 'delayed-album' && i === 2)
      await new Promise((resolve) => setTimeout(resolve, 1500));
    await send(
      photoFixture(seed + i, chatId, {
        album: `fictional-${seed}`,
        messageId: i + 1,
        topicId,
        userId,
      }),
    );
  }
} else {
  const update = photoFixture(seed, chatId, {
    document: scenario === 'document',
    topicId,
    userId,
  });
  await send(update);
  if (scenario === 'retry') await send(update);
}
