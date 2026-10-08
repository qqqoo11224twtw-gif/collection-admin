import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { orpc } from '~/lib/orpc';
import { useCasePermissions } from './management-hooks';
export function ReviewNotice() {
  const permissions = useCasePermissions();
  const options = orpc.reviews.pendingCount.queryOptions();
  const result = useQuery({
    ...options,
    queryKey: [permissions.userId, ...options.queryKey],
    enabled: permissions.can('review.view'),
  });
  if (!permissions.can('review.view')) return null;
  return (
    <Link
      to="/cases/reviews"
      search={{ page: 1, query: '', status: 'pending', type: '' }}
      className="text-sm font-medium hover:text-foreground"
    >
      待確認 {result.isSuccess ? result.data : '…'}
    </Link>
  );
}
