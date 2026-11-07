import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import InfoDot from './InfoDot.jsx';

const PADDLE_JS_URL = 'https://cdn.paddle.com/paddle/v2/paddle.js';

// Always visible on this branch — this is always the freemium SaaS
// product (free tier by default, subscribe for the full app; see
// server.js's "SaaS license tiers"), not an opt-in extra behind
// LICENSE_SERVER_URL. What DOES vary is whether the button is clickable:
// until a license server + Paddle are actually configured, the badge/caps
// still show but the button area reads "Upgrading isn't available yet"
// (see `config.enabled` below) — this lets the free/paid tier logic and
// the panel itself be verified with nothing more than the engine running.
// Nothing here is a license key: the "Subscribe" button opens Paddle's own
// hosted checkout overlay with this install's already-existing, anonymous
// instanceId silently attached — Paddle handles card entry and the
// recurring-autodebit mandate itself. When the payment completes, Paddle's
// webhook (see ../../../apps/hosted/license-server/) tells the license server this
// instanceId is paid; the NEXT heartbeat (within
// LICENSE_HEARTBEAT_INTERVAL_MS, 15 min by default) picks that up
// automatically. No restart, no file edit, nothing to paste.
export default function BillingPanel() {
  const [status, setStatus] = useState(null); // saas-license-status body
  const [config, setConfig] = useState(null); // billing/config body
  const [error, setError] = useState(null);
  const [paddleReady, setPaddleReady] = useState(false);
  const scriptLoadStarted = useRef(false);

  function load() {
    Promise.all([api.saasLicenseStatus(), api.billingConfig()])
      .then(([s, c]) => {
        setStatus(s);
        setConfig(c);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    load();
    // Slow poll — billing status doesn't change fast (a heartbeat only
    // fires every 15 minutes server-side), no reason to check more often
    // than the demo license banner already does.
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paddle.js is only loaded once billing is actually enabled server-side
  // (a real price id + client token configured) — no point loading a
  // third-party script for a build that can never use it.
  useEffect(() => {
    if (!config || !config.enabled || scriptLoadStarted.current) return;
    scriptLoadStarted.current = true;
    const script = document.createElement('script');
    script.src = PADDLE_JS_URL;
    script.onload = () => {
      if (config.environment === 'sandbox') window.Paddle.Environment.set('sandbox');
      window.Paddle.Initialize({ token: config.clientToken });
      setPaddleReady(true);
    };
    script.onerror = () => setError('Could not load Paddle checkout — try again in a moment.');
    document.head.appendChild(script);
  }, [config]);

  function openCheckout() {
    if (!paddleReady || !window.Paddle) return;
    window.Paddle.Checkout.open({
      items: [{ priceId: config.priceId, quantity: 1 }],
      // This is the entire mechanism: instanceId rides along invisibly,
      // Paddle hands it back in the webhook, no login/account/key needed
      // on either end. See apps/hosted/license-server/server.js's webhook handler.
      customData: { instanceId: config.instanceId },
    });
  }

  if (error) return <div className="mb-5 text-[13px] text-down">Couldn't load billing status: {error}</div>;
  if (!status) return null; // still loading — avoid a flash of empty state before the first response
  if (!status.saas) return null; // defensive only — `saas` is always true on this branch's engine build

  const isPaid = status.tier === 'paid';
  // Opens the account website's claim page in a new tab with this
  // install's instanceId attached — see apps/hosted/license-server/public/link-
  // instance.html and server.js's POST /v1/auth/link-instance. This is
  // the piece that makes a login on the website actually mean something:
  // without it, the account page can never show "here's your instance's
  // subscription status," only an email address. Shown regardless of
  // paid/free tier — linking an account is unrelated to whether this
  // install currently pays.
  const linkInstanceUrl =
    config && config.accountsUrl && config.instanceId
      ? `${config.accountsUrl.replace(/\/$/, '')}/link-instance.html?instanceId=${encodeURIComponent(config.instanceId)}`
      : null;

  return (
    <div className="mb-5 border border-border rounded-lg overflow-hidden">
      <div className="px-3.5 py-2.5 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span
            className={`text-[12px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
              isPaid ? 'text-up bg-up/10' : 'text-ink-dim bg-panel-raised'
            }`}
          >
            {isPaid ? 'Paid' : 'Free tier'}
          </span>
          {!isPaid && (
            <span className="text-[13px] text-ink-dim inline-flex items-center gap-1.5">
              Capped at 10 watched services, 15 days retention.
              <InfoDot title="Free tier applies whenever this install isn't currently subscribed — including before the first Subscribe click, or if a payment lapses for more than 48 hours (or the license server is unreachable for more than 5 days). Nothing already running is deleted; watching an 11th service is what gets blocked until you subscribe or free one up." />
            </span>
          )}
          {isPaid && <span className="text-[13px] text-ink-dim">Unlimited watched services, full retention control.</span>}
        </div>

        <div className="flex items-center gap-2.5">
          {linkInstanceUrl && (
            <a
              href={linkInstanceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] font-semibold text-ink hover:text-accent underline decoration-border underline-offset-2"
            >
              Link to my account
            </a>
          )}
          {!isPaid && config && config.enabled && (
            <button
              type="button"
              onClick={openCheckout}
              disabled={!paddleReady}
              className="text-[13px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 rounded-md px-3.5 py-1.5 disabled:opacity-50"
            >
              {paddleReady ? 'Subscribe' : 'Loading checkout…'}
            </button>
          )}
          {!isPaid && (!config || !config.enabled) && (
            <span className="text-[13px] text-muted">Upgrading isn't available yet — check back soon.</span>
          )}
        </div>
      </div>
    </div>
  );
}
