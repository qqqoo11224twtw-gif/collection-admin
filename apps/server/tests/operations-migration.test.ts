import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('upgrades populated legacy routes and outbound history without FK violations', async () => {
  const db = env.MIGRATION_DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 15));
  await db.batch([
    db.prepare(
      "INSERT INTO user(id,name,email,email_verified,role,created_at,updated_at) VALUES('legacy-admin','虛構管理員','legacy@example.test',0,'admin',1,1)",
    ),
    db.prepare(
      "INSERT INTO telegram_routes(id,chat_id,route_type,is_active,managed_by_user_id,created_at,updated_at) VALUES('legacy-route','-100123456','intake_source',1,'legacy-admin',1,1)",
    ),
    db.prepare(
      "INSERT INTO telegram_outbound_jobs(id,dedupe_key,message_type,route_id,payload,status,attempts,next_attempt_at,created_at) VALUES('legacy-job','legacy-key','command_reply','legacy-route','{}','pending',0,1,1)",
    ),
  ]);
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(15));
  expect(
    await db
      .prepare("SELECT id,name FROM telegram_routes WHERE id='legacy-route'")
      .first(),
  ).toEqual({ id: 'legacy-route', name: '' });
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
    [],
  );
  expect(
    await db
      .prepare(
        "SELECT active,permission_allow FROM user WHERE id='legacy-admin'",
      )
      .first(),
  ).toEqual({ active: 1, permission_allow: '[]' });
});
