import { beforeAll, describe, expect, it } from 'vitest';
import { rpc, signIn } from './helpers';

/**
 * Per-user data isolation — the pattern products copy for every
 * owned-by-a-user table. Two sessions, two disjoint todo lists; foreign ids
 * behave exactly like nonexistent ones (404, no existence leak).
 */

describe('todos ownership', () => {
  let alice: string;
  let bob: string;
  let aliceTodoId: number;

  beforeAll(async () => {
    [alice, bob] = await Promise.all([
      signIn('alice@example.com'),
      signIn('bob@example.com'),
    ]);
    const { status, body } = await rpc(
      'todos.createTodo',
      { text: 'alice private' },
      { cookie: alice },
    );
    expect(status).toBe(200);
    aliceTodoId = (body as { id: number }).id;
  });

  it("keeps each user's list private", async () => {
    const mine = await rpc('todos.getTodos', undefined, { cookie: alice });
    expect(
      (mine.body as Array<{ id: number }>).some((t) => t.id === aliceTodoId),
    ).toBe(true);

    const theirs = await rpc('todos.getTodos', undefined, { cookie: bob });
    expect(
      (theirs.body as Array<{ id: number }>).some((t) => t.id === aliceTodoId),
    ).toBe(false);
  });

  it("rejects updating another user's todo as NOT_FOUND", async () => {
    const { status } = await rpc(
      'todos.updateTodo',
      { id: aliceTodoId, completed: true },
      { cookie: bob },
    );
    expect(status).toBe(404);
  });

  it("rejects deleting another user's todo as NOT_FOUND, and the row survives", async () => {
    const { status } = await rpc(
      'todos.deleteTodo',
      { id: aliceTodoId },
      { cookie: bob },
    );
    expect(status).toBe(404);

    const mine = await rpc('todos.getTodos', undefined, { cookie: alice });
    expect(
      (mine.body as Array<{ id: number }>).some((t) => t.id === aliceTodoId),
    ).toBe(true);
  });
});
