/**
 * client.js — DeepSeek Harness Web GUI Client Plugin for dsh-model-sync.
 *
 * Adds a modern, interactive "Sync Models from models.dev" refresh button
 * directly in the Models settings page / capability panel headers.
 */

;(function () {
  let load = null;
  try {
    if (typeof window !== 'undefined' && window && typeof window.__ModuleLoader__ === 'object') {
      load = window.__ModuleLoader__.load.bind(window.__ModuleLoader__);
    }
  } catch {
    load = null;
  }
  if (!load) return;

  try {
    load({
      id: 'dsh-model-sync',
      factory: () => {
        const TOOLTIP = 'Sync model catalog from upstream & models.dev';
        const REFRESH_PATH = '/api/dsh-model-sync/refresh';
        const SEAT_ATTR = 'data-dsh-model-sync-refresh';
        const STYLE_ATTR = 'data-dsh-model-sync-style';
        const TOASTS_CONTAINER_ATTR = 'data-dsh-model-sync-toasts';

        const SUCCESS_MS = 6000;
        const ERROR_MS = 14000;

        /** Refresh circular arrows SVG */
        const REFRESH_ICON =
          '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M2.5 8a5.5 5.5 0 0 1 9.35-3.9M13.5 8a5.5 5.5 0 0 1-9.35 3.9" />' +
          '<polyline points="12 1.5 12 4.5 9 4.5" />' +
          '<polyline points="4 14.5 4 11.5 7 11.5" />' +
          '</svg>';

        /** Loading spinner SVG */
        const SPINNER_ICON =
          '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="24 12" aria-hidden="true">' +
          '<circle cx="8" cy="8" r="6" />' +
          '</svg>';

        const CSS = `
          [${SEAT_ATTR}] {
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            margin-left: 8px;
            padding: 3px;
            border-radius: 6px;
            cursor: pointer;
            color: var(--dsw-alias-neutral-30, #9ca3af);
            transition: color 0.15s ease, background-color 0.15s ease;
            user-select: none;
            vertical-align: middle;
          }
          [${SEAT_ATTR}]:hover {
            color: var(--dsw-alias-neutral-00, #ffffff);
            background-color: var(--dsw-alias-neutral-80, rgba(255, 255, 255, 0.08));
          }
          [${SEAT_ATTR}] .dms-icon {
            display: inline-flex;
            transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
          }
          [${SEAT_ATTR}]:hover .dms-icon {
            transform: rotate(180deg);
          }
          [${SEAT_ATTR}] .dms-spin {
            position: absolute;
            inset: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transform: scale(0.6);
            transition: opacity 0.2s ease, transform 0.2s ease;
            pointer-events: none;
          }
          [${SEAT_ATTR}].is-busy .dms-icon {
            opacity: 0;
            transform: scale(0.6);
          }
          [${SEAT_ATTR}].is-busy .dms-spin {
            opacity: 1;
            transform: scale(1);
          }
          [${SEAT_ATTR}].is-busy .dms-spin svg {
            animation: dms-rotate 0.85s linear infinite;
          }
          @keyframes dms-rotate {
            to { transform: rotate(360deg); }
          }
          .dms-toasts {
            position: fixed;
            right: 20px;
            bottom: 20px;
            z-index: 2147483640;
            display: flex;
            flex-direction: column;
            gap: 10px;
            width: 360px;
            max-width: calc(100vw - 40px);
            pointer-events: none;
          }
          .dms-toast {
            pointer-events: auto;
            background: var(--dsw-alias-toast-bg, #1e1e20);
            color: var(--dsw-alias-neutral-00, #f3f4f6);
            border: 1px solid var(--dsw-alias-border-l1, #374151);
            border-radius: 8px;
            padding: 12px 14px;
            font-size: 13px;
            line-height: 1.45;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
            animation: dms-toast-in 0.2s ease-out;
          }
          .dms-toast.ok {
            border-left: 4px solid var(--dsw-alias-state-success-primary, #10b981);
          }
          .dms-toast.error {
            border-left: 4px solid var(--dsw-alias-state-danger-primary, #ef4444);
          }
          .dms-toast-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 4px;
          }
          .dms-toast-head strong {
            font-weight: 600;
          }
          .dms-toast-close {
            background: none;
            border: none;
            color: inherit;
            cursor: pointer;
            font-size: 16px;
            line-height: 1;
            padding: 2px 6px;
            border-radius: 4px;
            opacity: 0.6;
          }
          .dms-toast-close:hover {
            opacity: 1;
          }
          .dms-toast-body {
            font-size: 12px;
            color: var(--dsw-alias-neutral-30, #d1d5db);
          }
          .dms-toast pre {
            max-height: 160px;
            overflow: auto;
            white-space: pre-wrap;
            word-break: break-word;
            margin: 8px 0 0;
            padding: 8px;
            background: rgba(0, 0, 0, 0.35);
            border-radius: 6px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 11px;
          }
          @keyframes dms-toast-in {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: none; }
          }
        `;

        function injectStyles() {
          if (document.querySelector(`[${STYLE_ATTR}]`)) return;
          const style = document.createElement('style');
          style.setAttribute(STYLE_ATTR, '');
          style.textContent = CSS;
          document.head.appendChild(style);
        }

        function getToastsRoot() {
          let root = document.querySelector(`[${TOASTS_CONTAINER_ATTR}]`);
          if (!root) {
            root = document.createElement('div');
            root.setAttribute(TOASTS_CONTAINER_ATTR, '');
            root.setAttribute('class', 'dms-toasts');
            document.body.appendChild(root);
          }
          return root;
        }

        function showToast(kind, { title, detail, stack = '' }) {
          const card = document.createElement('div');
          card.setAttribute('class', `dms-toast ${kind}`);
          card.setAttribute('role', kind === 'error' ? 'alert' : 'status');

          const head = document.createElement('div');
          head.setAttribute('class', 'dms-toast-head');
          const strong = document.createElement('strong');
          strong.textContent = title;
          const close = document.createElement('button');
          close.setAttribute('class', 'dms-toast-close');
          close.setAttribute('aria-label', 'Dismiss');
          close.textContent = '×';

          const dismiss = () => card.remove();
          close.addEventListener('click', dismiss);
          head.appendChild(strong);
          head.appendChild(close);
          card.appendChild(head);

          const bodyEl = document.createElement('div');
          bodyEl.setAttribute('class', 'dms-toast-body');
          bodyEl.textContent = detail;
          card.appendChild(bodyEl);

          if (stack) {
            const pre = document.createElement('pre');
            pre.textContent = stack;
            card.appendChild(pre);
          }

          getToastsRoot().appendChild(card);
          setTimeout(dismiss, kind === 'error' ? ERROR_MS : SUCCESS_MS);
        }

        function detectProviderKey(node) {
          for (let el = node; el !== null; el = el.parentElement) {
            for (const key of Object.keys(el)) {
              if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactContainer$')) continue;
              for (let fiber = el[key], depth = 0; fiber && depth < 40; depth += 1, fiber = fiber.return) {
                const provider = fiber.memoizedProps?.provider;
                if (typeof provider === 'string') return provider;
                if (typeof provider?.provider === 'string') return provider.provider;
                if (typeof provider?.id === 'string') return provider.id;
              }
            }
          }
          return undefined;
        }

        async function triggerSync(seat, route) {
          if (seat.classList.contains('is-busy')) return;
          seat.classList.add('is-busy');
          seat.title = 'Syncing models from models.dev...';

          try {
            const res = await fetch(REFRESH_PATH, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(route ? { route } : {}),
            });
            const data = await res.json().catch(() => ({}));

            if (!res.ok || data.ok !== true) {
              const msg = data.error || `HTTP ${res.status}`;
              showToast('error', {
                title: 'Model Sync Failed',
                detail: msg,
                stack: data.stack || '',
              });
              return;
            }

            const results = data.results || [];
            const summary = results
              .map((r) => `${r.provider}: +${r.added || 0} / ~${r.updated || 0}`)
              .join(', ') || 'Catalog is already up to date.';

            showToast('ok', {
              title: 'Models Synchronized',
              detail: summary,
            });
          } catch (err) {
            showToast('error', {
              title: 'Network Error',
              detail: err.message,
              stack: err.stack || '',
            });
          } finally {
            seat.classList.remove('is-busy');
            seat.title = TOOLTIP;
          }
        }

        function createRefreshButton(targetHeader) {
          if (targetHeader.querySelector(`[${SEAT_ATTR}]`)) return;

          const seat = document.createElement('span');
          seat.setAttribute(SEAT_ATTR, '');
          seat.setAttribute('role', 'button');
          seat.setAttribute('tabindex', '0');
          seat.setAttribute('aria-label', TOOLTIP);
          seat.title = TOOLTIP;

          const iconSpan = document.createElement('span');
          iconSpan.setAttribute('class', 'dms-icon');
          iconSpan.innerHTML = REFRESH_ICON;

          const spinSpan = document.createElement('span');
          spinSpan.setAttribute('class', 'dms-spin');
          spinSpan.innerHTML = SPINNER_ICON;

          seat.appendChild(iconSpan);
          seat.appendChild(spinSpan);

          const handleClick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const route = detectProviderKey(targetHeader);
            triggerSync(seat, route);
          };

          seat.addEventListener('click', handleClick);
          seat.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') handleClick(e);
          });

          // Insert before chevron or at the end of the header
          const chevron = targetHeader.querySelector('svg, [data-dsh-part="chevron"], [aria-expanded]');
          if (chevron && chevron.parentElement === targetHeader) {
            targetHeader.insertBefore(seat, chevron);
          } else {
            targetHeader.appendChild(seat);
          }
        }

        function scanAndMount() {
          injectStyles();

          // Strategy 1: Capability editor header
          const toggleHeaders = document.querySelectorAll(
            'section[data-dsh-plugin="model-capabilities"] button[data-dsh-part="toggle"], ' +
            'section[data-dsh-part="panel"] button[data-dsh-part="toggle"], ' +
            '[data-dsh-models-header]'
          );
          toggleHeaders.forEach(createRefreshButton);

          // Strategy 2: Provider card titles in Models settings
          const cardHeaders = document.querySelectorAll(
            '[data-dsh-settings-section="models"] [data-dsh-provider-card] h3, ' +
            '[data-dsh-settings-section="models"] [data-dsh-provider-card] header'
          );
          cardHeaders.forEach(createRefreshButton);
        }

        // Run scan initially
        scanAndMount();

        // Observe DOM mutations to keep button seated across React re-renders
        const observer = new MutationObserver(() => {
          scanAndMount();
        });

        observer.observe(document.body, { childList: true, subtree: true });
      },
    });
  } catch (err) {
    console.warn('[dsh-model-sync] Client initialization error:', err);
  }
})();
