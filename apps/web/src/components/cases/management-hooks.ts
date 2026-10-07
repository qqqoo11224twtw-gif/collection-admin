import type { AppRouterClient } from '@saasflare-dev/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '~/lib/auth';
import { orpc } from '~/lib/orpc';

export type Permission = Awaited<
  ReturnType<AppRouterClient['cases']['permissions']>
>[number];
export function useCasePermissions() {
  const { data: session } = useSession();
  const options = orpc.cases.permissions.queryOptions();
  const result = useQuery({
    ...options,
    queryKey: [session?.user.id, ...options.queryKey],
    enabled: !!session,
  });
  return {
    can: (permission: Permission) => result.data?.includes(permission) ?? false,
    userId: session?.user.id,
    isPending: result.isPending,
  };
}
export function useRefreshCases() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  return () =>
    queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === session?.user.id,
    });
}
