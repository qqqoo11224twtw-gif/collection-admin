export async function accountRequest<T>(
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(
    `${import.meta.env.NEXT_PUBLIC_SERVER_URL}/api/auth/${path}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const value = (await response.json()) as { message?: string };
  if (!response.ok) throw Error(value.message ?? '操作失敗，請稍後再試。');
  return value as T;
}
