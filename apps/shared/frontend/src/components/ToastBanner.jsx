import { useEffect } from 'react';

// Replaces window.alert() for in-app error/info messages. A native
// browser alert is attached to the browser's own chrome (it visibly
// "hangs" from under the address bar) and can't be styled to look like
// part of this app — this is a plain in-page banner instead: pinned near
// the top of the viewport, styled with the app's own accent/border
// colors, and dismissible by the user or automatically after a few
// seconds. Deliberately not a toast-library dependency — this app only
// ever needs one of these visible at a time.
export default function ToastBanner({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  if (!toast) return null;

  const isError = toast.variant !== 'info';

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-[90vw]">
      <div className="flex items-center gap-3 rounded-lg border border-accent bg-panel-raised shadow-lg px-4 py-2.5 text-[13px] font-medium">
        <span className={isError ? 'text-down' : 'text-ink'}>{toast.message}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted hover:text-ink text-[14px] leading-none"
          title="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
