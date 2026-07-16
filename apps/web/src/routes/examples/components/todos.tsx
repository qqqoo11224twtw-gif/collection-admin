import { createFileRoute } from '@tanstack/react-router';
import { AuthGate } from '~/components/auth-gate';
import { SourceCodeButton } from '~/components/source-code-button';
import { TodoList } from '~/components/todolist';

export const Route = createFileRoute('/examples/components/todos')({
  component: TodosPage,
});

/**
 * The per-user private data demo: sign in (any email in `open` mode), add
 * todos, sign in as someone else — each account sees only its own list. The
 * server scopes every query to the session user (packages/api/src/todos.ts).
 */
function TodosPage() {
  return (
    <AuthGate>
      <div className="space-y-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Private Todos Demo
            </h1>
            <p className="text-muted-foreground mt-2">
              Per-user private data: every query is scoped to the signed-in
              account — the pattern for any user-owned table.
            </p>
          </div>
          <SourceCodeButton path="packages/api/src/todos.ts" />
        </div>
        <TodoList />
      </div>
    </AuthGate>
  );
}
