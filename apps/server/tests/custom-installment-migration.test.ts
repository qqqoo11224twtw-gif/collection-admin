import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('0038 preserves existing plans and referenced schedules, retains guards and repeats safely', async () => {
  const db = env.MIGRATION_DB,
    migrations = env.TEST_MIGRATIONS;
  await applyD1Migrations(db, migrations.slice(0, -1));
  await db
    .prepare(
      "INSERT INTO user(id,name,email,created_at,updated_at) VALUES('migration-actor','虛構遷移人員','migration@example.test',1,1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO cases(id,case_no,code,customer_name,address,amount_due,status,revisit_status,revisit_reason,source,created_at,updated_at) VALUES('migration-case','MIG-38','MIG-38','虛構遷移案件','虛構地址',15000,'installment','not_needed','','manual',1,1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO installment_plans(id,case_id,plan_type,total_amount,deadline_date,status,created_by_user_id,created_at,updated_at) VALUES('migration-plan','migration-case','deadline',15000,'2027-01-01','active','migration-actor',1,1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO installment_schedules(id,plan_id,case_id,sequence,due_date,expected_amount,paid_amount,status,created_at,updated_at) VALUES('migration-schedule','migration-plan','migration-case',1,'2027-01-01',15000,3000,'partial',1,1)",
    )
    .run();
  await applyD1Migrations(db, migrations.slice(-1));
  await applyD1Migrations(db, migrations);
  expect(
    await db
      .prepare(
        'SELECT paid_amount,expected_amount,plan_id FROM installment_schedules WHERE id=?',
      )
      .bind('migration-schedule')
      .first(),
  ).toEqual({
    paid_amount: 3000,
    expected_amount: 15000,
    plan_id: 'migration-plan',
  });
  expect(
    (await db.prepare('PRAGMA foreign_key_check').all()).results,
  ).toHaveLength(0);
  expect(
    (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('installment_plans_void_case_guard','bulk_new_assignment_media_guard')",
        )
        .all()
    ).results,
  ).toHaveLength(2);
});
