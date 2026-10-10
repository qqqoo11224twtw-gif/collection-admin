import { useEffect } from 'react';

/** Only real input refreshes activity; session checks are background reads. */
export function SessionIdleGuard() {
  useEffect(() => {
    let busy = false;
    let pendingTouch = false;
    let lastTouch = 0;
    let authenticated = false;
    const endpoint = `${import.meta.env.NEXT_PUBLIC_SERVER_URL}/api/auth`;
    const check = async (touch: boolean) => {
      const onboarding =
        window.location.pathname === '/login' &&
        !!document.querySelector('[data-onboarding="true"]');
      if (
        window.location.pathname !== '/' &&
        !window.location.pathname.startsWith('/cases') &&
        !onboarding
      )
        return;
      if (busy) {
        pendingTouch ||= touch;
        return;
      }
      busy = true;
      const redirect = window.location.pathname + window.location.search;
      try {
        const response = await fetch(
          `${endpoint}/${touch ? 'activity' : onboarding ? 'onboarding-session' : 'get-session'}`,
          {
            method: touch ? 'POST' : 'GET',
            credentials: 'include',
            ...(touch
              ? { headers: { 'Content-Type': 'application/json' }, body: '{}' }
              : {}),
          },
        );
        const data = await response.json();
        if (
          response.status === 401 ||
          (!data && (authenticated || touch || onboarding))
        ) {
          window.location.assign(
            `/login?idle=true&redirect=${encodeURIComponent(redirect)}`,
          );
        }
        if (data && response.ok && !onboarding) authenticated = true;
      } finally {
        busy = false;
        if (pendingTouch) {
          pendingTouch = false;
          void check(true).catch(() => {});
        }
      }
    };
    const activity = (event: Event) => {
      if (!event.isTrusted || Date.now() - lastTouch < 1000) return;
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(
          'button,a,input,textarea,select,[role="button"],[role="tab"]',
        )
      )
        return;
      lastTouch = Date.now();
      void check(true).catch(() => {});
    };
    for (const kind of ['click', 'input', 'keydown'])
      window.addEventListener(kind, activity);
    void check(false).catch(() => {});
    const timer = window.setInterval(
      () => void check(false).catch(() => {}),
      10000,
    );
    return () => {
      window.clearInterval(timer);
      for (const kind of ['click', 'input', 'keydown'])
        window.removeEventListener(kind, activity);
    };
  }, []);
  return null;
}
