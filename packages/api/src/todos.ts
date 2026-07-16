import { ORPCError } from '@orpc/server';
import { todos } from '@saasflare-dev/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { protectedProcedure } from './middleware';

/**
 * The template's per-user private data demo: every query is scoped to the
 * session user, so two signed-in users see two independent todo lists. This
 * is the pattern products copy for their own owned-by-a-user tables.
 */
export const todosApi = {
  getTodos: protectedProcedure.handler(async ({ context }) => {
    return context.DB.select()
      .from(todos)
      .where(eq(todos.userId, context.user.id))
      .all();
  }),
  createTodo: protectedProcedure
    .input(
      z.object({
        text: z.string(),
      }),
    )
    .handler(async ({ context, input }) => {
      const [newTodo] = await context.DB.insert(todos)
        .values({ ...input, userId: context.user.id, createdAt: new Date() })
        .returning();
      return newTodo;
    }),
  updateTodo: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        text: z.string().optional(),
        completed: z.boolean().optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      const { id, ...updateData } = input;
      // Ownership is part of the WHERE clause — another user's todo id
      // behaves exactly like a nonexistent one.
      const [updatedTodo] = await context.DB.update(todos)
        .set(updateData)
        .where(and(eq(todos.id, id), eq(todos.userId, context.user.id)))
        .returning();
      if (!updatedTodo) {
        throw new ORPCError('NOT_FOUND');
      }
      return updatedTodo;
    }),
  deleteTodo: protectedProcedure
    .input(
      z.object({
        id: z.number(),
      }),
    )
    .handler(async ({ context, input }) => {
      const [deletedTodo] = await context.DB.delete(todos)
        .where(and(eq(todos.id, input.id), eq(todos.userId, context.user.id)))
        .returning();
      if (!deletedTodo) {
        throw new ORPCError('NOT_FOUND');
      }
      return deletedTodo;
    }),
};
