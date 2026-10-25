import { env } from 'cloudflare:workers';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  createBulkCases,
  uploadCaseImages,
  createContext,
  requirePermission,
  telegramPrincipal,
} from '../../../../production-restored/api/legacy-api.js';
import { handleTelegramOcrAdmin } from '../src/telegram-ocr-admin';
import {
  handleTelegramOcr,
  processTelegramOcrJobs,
} from '../src/telegram-ocr-extension';

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Statement(this.db, this.sql, args);
  }
  first(column) {
    const row = this.db.prepare(this.sql).get(...this.args);
    return Promise.resolve(column ? (row?.[column] ?? null) : (row ?? null));
  }
  all() {
    const results = this.db.prepare(this.sql).all(...this.args);
    return Promise.resolve({ results, success: true, meta: { changes: 0 } });
  }
  raw() {
    const statement = this.db.prepare(this.sql);
    statement.setReturnArrays(true);
    return Promise.resolve(statement.all(...this.args));
  }
  runSync() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
      },
    };
  }
  run() {
    return Promise.resolve(this.runSync());
  }
}
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync('packages/db/migrations')
    .filter((path) => path.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync('packages/db/migrations/' + file, 'utf8'));
  sqlite.exec(readFileSync('deploy/telegram-ocr/migration.sql', 'utf8'));
  const db = {
    prepare: (sql) => new Statement(sqlite, sql),
    batch: async (statements) => {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map((statement) => statement.runSync());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const now = Date.now();
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at,role,active) VALUES('admin','管理員','ocr-fixture@example.invalid',1,?,?,'admin',1)",
    )
    .run(now, now);
  sqlite
    .prepare(
      "INSERT INTO telegram_bots(id,username,internal_name,is_active,created_at,updated_at,telegram_bot_id,display_name,ciphertext,nonce,verified_at) VALUES('bot','wanwanautoresponder_bot','fixture',1,?,?,'123','fixture','test-only','test-only',1)",
    )
    .run(now, now);
  sqlite
    .prepare(
      "INSERT INTO telegram_routes(id,name,bot_id,chat_id,route_type,is_active,managed_by_user_id,created_at,updated_at) VALUES('route','fixture','bot','-100123','intake',1,'admin',?,?)",
    )
    .run(now, now);
  Object.assign(env, {
    DB: db,
    AUTH_MODE: 'open',
    ACCOUNT_AUTH_MODE: 'managed',
    BETTER_AUTH_SECRET: 'fixture-only-not-a-production-secret',
    SERVER_URL: 'http://localhost:4100',
    TELEGRAM_OCR_ENABLED: 'true',
    TELEGRAM_OCR_REVIEW_MODE: 'backend',
    TELEGRAM_WEBHOOK_SECRET: 'fixture-secret',
    BULK_OCR_PRIVACY_APPROVED: 'true',
    GOOGLE_VISION_API_KEY: 'fixture-google',
    OPENAI_API_KEY: 'fixture-openai',
    BULK_OCR_MODEL: 'fixture-model',
    CORS_ORIGIN: 'https://admin.kpirich.bid',
  });
  const tasks = [];
  const execution = { waitUntil: (promise) => tasks.push(promise) };
  const image = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX9sAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const runtime = {
    base: async () =>
      createContext({
        req: { raw: new Request('https://api.kpirich.bid/') },
        executionCtx: execution,
      }),
    actor: telegramPrincipal,
    requirePermission,
    client: async () => ({
      downloadFile: async () => ({
        bytes: image.buffer,
        mediaType: 'image/png',
      }),
      sendMessage: async () => {
        throw Error('Backend review must not send personal fields to group');
      },
    }),
    create: createBulkCases,
  };
  return { sqlite, db, execution, runtime, tasks };
}
const visual = {
  quality: 'readable',
  code: {
    value: '菲菲',
    evidence: '莊佩璇 菲菲 ATM',
    source: 'caption',
    legible: true,
    ambiguous: false,
  },
  customerName: {
    value: '莊佩璇',
    evidence: '莊佩璇',
    source: 'id_front',
    legible: true,
    ambiguous: false,
  },
  region: {
    value: '彰化縣',
    evidence: '彰化縣',
    source: 'current_address',
    legible: true,
    ambiguous: false,
  },
};
async function providers(action) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (String(url).startsWith('https://vision.googleapis.com/'))
      return Response.json({
        responses: [
          {
            fullTextAnnotation: {
              text: '姓名 莊佩璇\n戶籍地址 彰化縣\n莊佩璇 菲菲 ATM',
            },
          },
        ],
      });
    if (String(url) === 'https://api.openai.com/v1/responses')
      return Response.json({
        status: 'completed',
        output: [
          { content: [{ type: 'output_text', text: JSON.stringify(visual) }] },
        ],
      });
    throw Error('Unexpected network destination');
  };
  try {
    await action(() => calls);
  } finally {
    globalThis.fetch = original;
  }
}
function update(id = 123) {
  return new Request('https://api.kpirich.bid/api/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'fixture-secret',
    },
    body: JSON.stringify({
      update_id: id,
      message: {
        message_id: id,
        from: { id: 987, is_bot: false, first_name: 'Fixture' },
        chat: { id: -100123, type: 'supergroup' },
        date: 1,
        photo: [
          {
            file_id: 'fixture-image',
            file_unique_id: 'fixture-unique',
            width: 1,
            height: 1,
            file_size: 68,
          },
        ],
      },
    }),
  });
}
function adminRequest(path, value, origin = 'https://admin.kpirich.bid') {
  return new Request('https://api.kpirich.bid/api/telegram-ocr' + path, {
    method: value === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}
test('Telegram upload -> dual OCR -> backend manual review -> original production create, with replay and expired recovery', async () => {
  const f = fixture();
  try {
    await providers(async (calls) => {
      const queued = await handleTelegramOcr(
        update(),
        env,
        f.execution,
        f.runtime,
      );
      assert.equal(queued.status, 200);
      assert.equal((await queued.json()).code, 'OCR_QUEUED');
      await handleTelegramOcr(update(), env, f.execution, f.runtime);
      assert.equal(
        f.sqlite.prepare('SELECT count(*) AS n FROM telegram_ocr_jobs').get().n,
        1,
      );
      assert.equal(
        f.sqlite.prepare('SELECT count(*) AS n FROM cases').get().n,
        0,
      );
      await processTelegramOcrJobs(env, f.execution, f.runtime);
      let job = f.sqlite.prepare('SELECT * FROM telegram_ocr_jobs').get();
      assert.equal(job.status, 'ready');
      assert.equal(calls(), 2);
      assert.equal(JSON.parse(job.fields_json).customerName, '莊佩璇');
      assert.equal(
        f.sqlite.prepare('SELECT count(*) AS n FROM cases').get().n,
        0,
      );
      const base = await f.runtime.base(),
        admin = await telegramPrincipal(base, 'admin');
      assert.equal(
        (
          await handleTelegramOcrAdmin(
            adminRequest('/jobs'),
            base,
            f.execution,
            f.runtime,
          )
        ).status,
        401,
      );
      const fields = JSON.parse(job.fields_json),
        path = '/jobs/' + job.id + '/confirm';
      assert.equal(
        (
          await handleTelegramOcrAdmin(
            adminRequest(
              path,
              { version: job.version, fields, reviewed: true },
              'https://evil.invalid',
            ),
            admin,
            f.execution,
            f.runtime,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await handleTelegramOcrAdmin(
            adminRequest(path, {
              version: job.version,
              fields,
              reviewed: false,
            }),
            admin,
            f.execution,
            f.runtime,
          )
        ).status,
        422,
      );
      assert.equal(
        (
          await handleTelegramOcrAdmin(
            adminRequest(path, {
              version: job.version,
              fields: { ...fields, code: 'ATM' },
              reviewed: true,
            }),
            admin,
            f.execution,
            f.runtime,
          )
        ).status,
        422,
      );
      assert.equal(
        (
          await handleTelegramOcrAdmin(
            adminRequest(path, {
              version: job.version,
              fields,
              reviewed: true,
            }),
            admin,
            f.execution,
            f.runtime,
          )
        ).status,
        202,
      );
      await Promise.all(f.tasks);
      job = f.sqlite.prepare('SELECT * FROM telegram_ocr_jobs').get();
      assert.equal(job.status, 'created');
      assert.equal(
        f.sqlite.prepare('SELECT count(*) AS n FROM cases').get().n,
        1,
      );
      assert.equal(
        (
          await handleTelegramOcrAdmin(
            adminRequest(path, { version: 0, fields, reviewed: true }),
            admin,
            f.execution,
            f.runtime,
          )
        ).status,
        409,
      );
      f.sqlite
        .prepare(
          "UPDATE telegram_ocr_jobs SET status='creating',lease_token=NULL,lease_until=NULL,expires_at=?",
        )
        .run(Date.now() - 1);
      await processTelegramOcrJobs(env, f.execution, f.runtime);
      assert.equal(
        f.sqlite.prepare('SELECT count(*) AS n FROM cases').get().n,
        1,
      );
      assert.equal(
        f.sqlite.prepare('SELECT count(*) AS n FROM telegram_ocr_jobs').get().n,
        0,
      );
    });
  } finally {
    f.sqlite.close();
  }
});
test('unapproved group, invalid webhook and inactive manager cannot invoke paid OCR', async () => {
  const f = fixture();
  try {
    await providers(async (calls) => {
      const request = update();
      request.headers.set('X-Telegram-Bot-Api-Secret-Token', 'wrong');
      assert.equal(
        (await handleTelegramOcr(request, env, f.execution, f.runtime)).status,
        401,
      );
      f.sqlite.exec('UPDATE telegram_routes SET is_active=0');
      assert.equal(
        await handleTelegramOcr(update(124), env, f.execution, f.runtime),
        null,
      );
      f.sqlite.exec(
        'UPDATE telegram_routes SET is_active=1; UPDATE user SET active=0',
      );
      assert.equal(
        (await handleTelegramOcr(update(125), env, f.execution, f.runtime))
          .status,
        200,
      );
      assert.equal(
        f.sqlite.prepare('SELECT count(*) AS n FROM telegram_ocr_jobs').get().n,
        0,
      );
      assert.equal(calls(), 0);
    });
  } finally {
    f.sqlite.close();
  }
});

test('one failed provider response does not affect the next image', async () => {
  const f = fixture();
  try {
    await providers(async () => {
      await handleTelegramOcr(update(201), env, f.execution, f.runtime);
      await handleTelegramOcr(update(202), env, f.execution, f.runtime);
      const normal = globalThis.fetch;
      let first = true;
      globalThis.fetch = async (...args) => {
        if (first) {
          first = false;
          return new Response('unavailable', { status: 503 });
        }
        return normal(...args);
      };
      await processTelegramOcrJobs(env, f.execution, f.runtime);
      const states = f.sqlite
        .prepare('SELECT status FROM telegram_ocr_jobs ORDER BY message_id')
        .all()
        .map((row) => row.status);
      assert.deepEqual(states, ['failed', 'ready']);
      assert.equal(
        f.sqlite.prepare('SELECT count(*) AS n FROM cases').get().n,
        0,
      );
    });
  } finally {
    f.sqlite.close();
  }
});

test('two separately confirmed images with the same name and code cannot create duplicate cases', async () => {
  const f = fixture();
  try {
    await providers(async () => {
      const context = await telegramPrincipal(await f.runtime.base(), 'admin');
      for (const id of [301, 302]) {
        await handleTelegramOcr(update(id), env, f.execution, f.runtime);
        await processTelegramOcrJobs(env, f.execution, f.runtime);
        const job = f.sqlite
          .prepare('SELECT * FROM telegram_ocr_jobs WHERE message_id=?')
          .get(id);
        const response = await handleTelegramOcrAdmin(
          adminRequest(`/jobs/${job.id}/confirm`, {
            version: job.version,
            reviewed: true,
            fields: JSON.parse(job.fields_json),
          }),
          context,
          f.execution,
          f.runtime,
        );
        assert.equal(response.status, 202);
        await Promise.all(f.tasks);
      }
      assert.equal(
        f.sqlite.prepare('SELECT count(*) AS n FROM cases').get().n,
        1,
      );
      assert.deepEqual(
        f.sqlite
          .prepare('SELECT status FROM telegram_ocr_jobs ORDER BY message_id')
          .all()
          .map((row) => row.status),
        ['created', 'failed'],
      );
    });
  } finally {
    f.sqlite.close();
  }
});
test('opt-in automatic creation preserves replay protection and abstains on uncertain fields', async () => {
 const f=fixture(); env.TELEGRAM_OCR_AUTO_CREATE='true';
 try { await providers(async()=>{
   await handleTelegramOcr(update(901),env,f.execution,f.runtime);
   await processTelegramOcrJobs(env,f.execution,f.runtime);
   assert.equal(f.sqlite.prepare('SELECT status FROM telegram_ocr_jobs').get().status,'creating');
   await processTelegramOcrJobs(env,f.execution,f.runtime);
   await processTelegramOcrJobs(env,f.execution,f.runtime);
   assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM cases').get().n,1);
   const normal=globalThis.fetch;
   globalThis.fetch=async(...args)=>{
     const response=await normal(...args);
     if(String(args[0]).includes('api.openai.com')){
       const body=await response.json();const raw=JSON.parse(body.output[0].content[0].text);
       raw.code.ambiguous=true;body.output[0].content[0].text=JSON.stringify(raw);return Response.json(body);
     } return response;
   };
   await handleTelegramOcr(update(902),env,f.execution,f.runtime);
   await processTelegramOcrJobs(env,f.execution,f.runtime);
   assert.equal(f.sqlite.prepare('SELECT status FROM telegram_ocr_jobs ORDER BY message_id DESC LIMIT 1').get().status,'ready');
   assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM cases').get().n,1);
 }); } finally { delete env.TELEGRAM_OCR_AUTO_CREATE; f.sqlite.close(); }
});
test('batch receipt and completion report go only to the source route and completed jobs leave inbox', async()=>{
 const f=fixture();env.TELEGRAM_OCR_AUTO_CREATE='true';env.TELEGRAM_OCR_BATCH_REPORTS='true';
 const messages=[];const client=await f.runtime.client();f.runtime.client=async()=>({...client,sendMessage:async payload=>{messages.push(payload);return String(messages.length)}});
 try {await providers(async()=>{
  await handleTelegramOcr(update(1001),env,f.execution,f.runtime);await Promise.all(f.tasks);
  await handleTelegramOcr(update(1001),env,f.execution,f.runtime);await Promise.all(f.tasks);
  assert.equal(messages.length,1);assert.equal(messages[0].text,'已收到案件，排入建檔');assert.equal(messages[0].chatId,'-100123');
  await processTelegramOcrJobs(env,f.execution,f.runtime);
  f.sqlite.exec('UPDATE telegram_ocr_report_batches SET received_at=received_at-31000');
  await processTelegramOcrJobs(env,f.execution,f.runtime);
  await processTelegramOcrJobs(env,f.execution,f.runtime);
  assert.equal(messages.length,2);assert.ok(messages[1].text.includes('菲菲 莊佩璇 彰化'));assert.ok(messages[1].text.includes('共 1 件，已建檔'));
  const context=await telegramPrincipal(await f.runtime.base(),'admin');
  const result=await handleTelegramOcrAdmin(new Request('https://api.kpirich.bid/api/telegram-ocr/jobs'),context,f.execution,f.runtime);
  assert.equal((await result.json()).jobs.length,0);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM cases').get().n,1);
 });}finally{delete env.TELEGRAM_OCR_AUTO_CREATE;delete env.TELEGRAM_OCR_BATCH_REPORTS;f.sqlite.close()}
});

test('case is complete only after private original image upload; retry cannot duplicate case or media',async()=>{
 const f=fixture();env.TELEGRAM_OCR_AUTO_CREATE='true';env.TELEGRAM_OCR_ATTACH_IMAGES='true';env.CASE_STORAGE_MODE='r2';
 const objects=new Map();env.CASE_BUCKET={put:async(key,bytes)=>{objects.set(key,bytes);return {}},delete:async key=>objects.delete(key)};
 let fail=true;
 f.runtime.attach=async(context,caseId,key,bytes,type)=>{
  if(fail)throw Error('fixture storage failure');
  const record=f.sqlite.prepare('SELECT version FROM cases WHERE id=?').get(caseId);
  const form=new FormData();form.append('files',new Blob([bytes],{type}),'telegram.png');form.append('uploadKey',key);form.append('expectedVersion',String(record.version));
  return uploadCaseImages(context,caseId,new Request('https://api.kpirich.bid/upload',{method:'POST',headers:{Origin:'https://admin.kpirich.bid'},body:form}));
 };
 try {await providers(async()=>{
  await handleTelegramOcr(update(1101),env,f.execution,f.runtime);await processTelegramOcrJobs(env,f.execution,f.runtime);await processTelegramOcrJobs(env,f.execution,f.runtime);
  assert.equal(f.sqlite.prepare('SELECT status FROM telegram_ocr_jobs').get().status,'creating');
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM cases').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM case_media').get().n,0);
  fail=false;f.sqlite.exec('UPDATE telegram_ocr_jobs SET lease_until=0');
  await processTelegramOcrJobs(env,f.execution,f.runtime);await processTelegramOcrJobs(env,f.execution,f.runtime);
  assert.equal(f.sqlite.prepare('SELECT status FROM telegram_ocr_jobs').get().status,'created');
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM cases').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM case_media').get().n,1);assert.equal(objects.size,1);
 });}finally{delete env.TELEGRAM_OCR_AUTO_CREATE;delete env.TELEGRAM_OCR_ATTACH_IMAGES;delete env.CASE_STORAGE_MODE;delete env.CASE_BUCKET;f.sqlite.close()}
});
