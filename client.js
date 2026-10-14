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
      factory: () => ({
        apply(ctx) {
        let disposed = false;
        const nodes = new Set();
        const listeners = new Set();
        const timers = new Set();

        function listen(node, type, callback) {
          node.addEventListener(type, callback);
          listeners.add(() => node.removeEventListener(type, callback));
        }

        /** Prefer DSH locale service, then <html lang>, then browser languages. */
        function isZh() {
          try {
            const active = ctx.locale && ctx.locale.getSnapshot && ctx.locale.getSnapshot().active;
            if (typeof active === 'string' && active) return /^zh/i.test(active);
          } catch { /* locale optional for DOM-injected client */ }
          const langs = [];
          try {
            if (typeof navigator !== 'undefined') {
              if (Array.isArray(navigator.languages)) langs.push(...navigator.languages);
              if (navigator.language) langs.push(navigator.language);
            }
          } catch { /* ignore */ }
          try {
            const docLang = document.documentElement && document.documentElement.lang;
            if (docLang) langs.push(docLang);
          } catch { /* ignore */ }
          return langs.some((l) => /^zh/i.test(String(l || '')));
        }

        function getT() {
          return isZh() ? {
            tipAll: '全量刷新：拉取所有可同步供应商的 /models', tipOne: (p) => `刷新 ${p}：拉取该供应商网关全量模型列表`,
            tipMenu: '预览 / 选择供应商', busy: '正在同步…',
            all: '全量刷新', preview: '预览（不写入）', loading: '加载供应商…', none: '没有可同步的供应商',
            okTitle: '模型已同步', previewTitle: '预览结果（未写入）', failTitle: '模型同步失败', partTitle: '部分同步失败', netTitle: '网络错误',
            upToDate: '已是最新', skipped: (n) => `跳过 ${n} 个无效或非聊天模型`,
            fetched: (n) => `网关 ${n} 个`, empty: '目录已是最新', dismiss: '关闭',
            added: (n) => `新增 +${n}`, updated: (n) => `更新 ~${n}`, removed: (n) => `移除 -${n}`,
            modelsHint: (n) => `${n} 个模型`,
          } : {
            tipAll: 'Refresh all: pull /models for every syncable provider', tipOne: (p) => `Refresh ${p}: pull that gateway's full model list`,
            tipMenu: 'Preview / pick a provider', busy: 'Syncing…',
            all: 'Refresh all', preview: 'Preview (no write)', loading: 'Loading providers…', none: 'No syncable providers',
            okTitle: 'Models synchronized', previewTitle: 'Preview (not written)', failTitle: 'Model sync failed', partTitle: 'Model sync partially failed', netTitle: 'Network error',
            upToDate: 'already up to date', skipped: (n) => `${n} invalid or non-chat model(s) skipped`,
            fetched: (n) => `gateway ${n}`, empty: 'Catalog is already up to date.', dismiss: 'Dismiss',
            added: (n) => `+${n} added`, updated: (n) => `~${n} updated`, removed: (n) => `-${n} removed`,
            modelsHint: (n) => `${n} models`,
          };
        }

        /** Map known English API / sync errors into Chinese when UI is zh. */
        function localizeError(msg) {
          const raw = String(msg || '');
          if (!isZh() || !raw) return raw;
          const rules = [
            [/^unknown provider$/i, '未知供应商'],
            [/^provider has no baseURL$/i, '供应商未配置 baseURL'],
            [/^Access denied: loopback only$/i, '拒绝访问：仅本机回环'],
            [/^Method not allowed$/i, '不允许的方法'],
            [/^Content-Type must be application\/json$/i, 'Content-Type 必须为 application/json'],
            [/^Cross-origin request rejected$/i, '已拒绝跨域请求'],
            [/^DSH settings service is not yet available$/i, 'DSH settings 服务尚未就绪'],
            [/^Request payload too large$/i, '请求体过大'],
            [/^Malformed JSON body: (.+)$/i, 'JSON 请求体无效：$1'],
            [/^gateway timed out after (\d+) ms$/i, '网关超时（$1 ms）'],
            [/^settings rejected the update: (.+)$/i, '设置拒绝写入：$1'],
            [/^protocol "([^"]+)" has no model listing this plugin can read \(supported: (.+)\)$/i, '协议 "$1" 不支持拉取模型列表（支持：$2）'],
            [/^Refusing to write ([^:]+): (.+)$/i, '拒绝写入 $1：$2'],
            [/^Upstream (.+) returned (\d+)(.*)$/i, '上游 $1 返回 $2$3'],
            [/^Upstream (.+) did not return JSON$/i, '上游 $1 未返回 JSON'],
            [/^Endpoint (.+) returned (\d+)$/i, '端点 $1 返回 $2'],
            [/^Expected a model listing from (.+) \(data\[\] or models\{\}\), got (.+)$/i, '期望 $1 返回模型列表（data[] 或 models{}），实际为 $2'],
            [/^Failed to fetch models from candidate endpoints: (.+)$/i, '无法从候选端点拉取模型：$1'],
            [/^HTTP (\d+)$/i, 'HTTP $1'],
          ];
          for (const [re, tpl] of rules) {
            const m = raw.match(re);
            if (m) {
              let out = tpl;
              for (let i = 1; i < m.length; i += 1) out = out.replace(`$${i}`, m[i] ?? '');
              return out;
            }
          }
          return raw;
        }

        function acceptLanguage() {
          return isZh() ? 'zh-CN,zh;q=0.9,en;q=0.5' : 'en;q=0.9';
        }

        // Back-compat alias used by older call sites in this file during edits.
        let T = getT();
        const MENU_ATTR = 'data-dsh-model-sync-menu';
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
            width: 28px;
            height: 28px;
            margin: 0 4px;
            padding: 3px;
            border-radius: var(--dsw-radius-sm, 6px);
            border: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.12));
            cursor: pointer;
            color: var(--dsw-alias-label-secondary, #9ca3af);
            background: transparent;
            transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
            user-select: none;
            vertical-align: middle;
            box-sizing: border-box;
            gap: 4px;
            font: inherit;
            font-size: 12px;
            line-height: 1;
            white-space: nowrap;
          }
          [${SEAT_ATTR}].dms-labeled {
            width: auto;
            height: 28px;
            padding: 0 10px 0 8px;
            color: var(--dsw-alias-label-primary, #ffffff);
            border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.2));
            background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06));
            font-weight: 500;
          }
          [${SEAT_ATTR}].dms-labeled .dms-label {
            display: inline-block;
            max-width: 8em;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          [${SEAT_ATTR}].dms-menu-btn {
            width: 22px;
            margin-left: 0;
          }
          .dms-title-actions {
            display: inline-flex;
            align-items: center;
            margin-left: 8px;
            vertical-align: middle;
            gap: 2px;
          }
          [${SEAT_ATTR}]:hover {
            color: var(--dsw-alias-label-primary, #ffffff);
            background-color: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
            border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.2));
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
          .dms-menu {
            position: fixed; z-index: 2147483641; min-width: 180px; padding: 4px;
            background: var(--dsw-alias-toast-bg, #1e1e20); color: var(--dsw-alias-neutral-00, #f3f4f6);
            border: 1px solid var(--dsw-alias-border-l1, #374151); border-radius: 8px;
            box-shadow: 0 10px 30px rgba(0,0,0,.45); font-size: 13px;
          }
          .dms-menu button { display: flex; justify-content: space-between; gap: 12px; width: 100%; padding: 6px 10px;
            background: none; border: 0; color: inherit; text-align: left; border-radius: 6px; cursor: pointer; font: inherit; }
          .dms-menu button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
          .dms-menu hr { border: 0; border-top: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12)); margin: 4px 0; }
          .dms-menu small { opacity: .6; }
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
            white-space: pre-wrap;
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
          nodes.add(style);
          document.head.appendChild(style);
        }

        function getToastsRoot() {
          let root = document.querySelector(`[${TOASTS_CONTAINER_ATTR}]`);
          if (!root) {
            root = document.createElement('div');
            root.setAttribute(TOASTS_CONTAINER_ATTR, '');
            root.setAttribute('class', 'dms-toasts');
            nodes.add(root);
            document.body.appendChild(root);
          }
          return root;
        }

        function showToast(kind, { title, detail, stack = '' }) {
          if (disposed) return;
          const card = document.createElement('div');
          card.setAttribute('class', `dms-toast ${kind}`);
          card.setAttribute('role', kind === 'error' ? 'alert' : 'status');

          const head = document.createElement('div');
          head.setAttribute('class', 'dms-toast-head');
          const strong = document.createElement('strong');
          strong.textContent = title;
          const close = document.createElement('button');
          close.setAttribute('class', 'dms-toast-close');
          close.setAttribute('aria-label', getT().dismiss);
          close.textContent = '×';

          let timer;
          const dismiss = () => {
            card.remove();
            close.removeEventListener('click', dismiss);
            listeners.delete(unlisten);
            clearTimeout(timer);
            timers.delete(timer);
          };
          const unlisten = () => close.removeEventListener('click', dismiss);
          close.addEventListener('click', dismiss);
          listeners.add(unlisten);
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
          timer = setTimeout(dismiss, kind === 'error' ? ERROR_MS : SUCCESS_MS);
          timers.add(timer);
        }

        function detectProviderKey(node) {
          for (let el = node; el !== null; el = el.parentElement) {
            for (const key of Object.keys(el)) {
              if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactContainer$')) continue;
              for (let fiber = el[key], depth = 0; fiber && depth < 40; depth += 1, fiber = fiber.return) {
                const row = fiber.memoizedProps?.row;
                if (typeof row?.entry?.provider === 'string') return row.entry.provider;
                const target = fiber.memoizedProps?.target;
                if (typeof target?.provider === 'string') return target.provider;
                const provider = fiber.memoizedProps?.provider;
                if (typeof provider === 'string') return provider;
                if (typeof provider?.provider === 'string') return provider.provider;
                if (typeof provider?.id === 'string') return provider.id;
              }
            }
          }
          const rowCard = node.closest?.('li, [class*="_rowCard"], [class*="_rowHead"]');
          if (rowCard) {
            const nameEl = rowCard.querySelector?.('[class*="_rowName"]');
            if (nameEl && nameEl.textContent) {
              const name = nameEl.textContent.trim();
              if (name) return name;
            }
          }
          return undefined;
        }

        async function triggerSync(seat, route, dryRun = false) {
          if (disposed || seat.classList.contains('is-busy')) return;
          const idleTitle = seat.title;
          T = getT();
          seat.classList.add('is-busy');
          seat.title = T.busy;

          try {
            const res = await fetch(REFRESH_PATH, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept-Language': acceptLanguage() },
              body: JSON.stringify(dryRun ? { ...(route ? { route } : {}), dryRun: true } : (route ? { route } : {})),
            });
            const data = await res.json().catch(() => ({}));

            if (!res.ok || data.ok !== true) {
              const msg = localizeError(data.error || `HTTP ${res.status}`);
              showToast('error', {
                title: T.failTitle,
                detail: msg,
                stack: data.stack || '',
              });
              return;
            }

            const results = data.results || [];
            const failed = results.filter((r) => r.error);
            const okRes = results.filter((r) => !r.error);
            const parts = okRes.map((r) => {
              const delta = (r.added || 0) + (r.updated || 0) + (r.removed || 0);
              const head = typeof r.fetched === 'number' ? `${T.fetched(r.fetched)} · ` : '';
              if (delta === 0) return `${r.provider}: ${head}${T.upToDate}`;
              const bits = [T.added(r.added || 0), T.updated(r.updated || 0)];
              if (r.removed) bits.push(T.removed(r.removed));
              return `${r.provider}: ${head}${bits.join(' / ')}`;
            });
            const skipped = okRes.reduce((n, r) => n + (r.skipped || 0), 0);
            if (skipped) parts.push(T.skipped(skipped));
            const detail = parts.join('\n') || T.empty;

            if (failed.length > 0) {
              showToast('error', {
                title: failed.length === results.length ? T.failTitle : T.partTitle,
                detail: [...failed.map((r) => `${r.provider}: ${localizeError(r.error)}`), detail].join('\n'),
              });
            } else {
              showToast('ok', { title: dryRun ? T.previewTitle : T.okTitle, detail });
            }
          } catch (err) {
            showToast('error', {
              title: T.netTitle,
              detail: localizeError(err.message),
              stack: err.stack || '',
            });
          } finally {
            seat.classList.remove('is-busy');
            seat.title = idleTitle;
          }
        }

        let menuEl = null;
        let menuOff = null;
        function closeMenu() {
          if (menuOff) menuOff();
          menuOff = null;
          if (menuEl) { menuEl.remove(); nodes.delete(menuEl); }
          menuEl = null;
        }
        function menuItem(label, hint, onPick) {
          const b = document.createElement('button');
          b.setAttribute('type', 'button');
          b.textContent = label;
          if (hint !== undefined) { const sm = document.createElement('small'); sm.textContent = hint; b.appendChild(sm); }
          listen(b, 'click', (e) => { e.preventDefault(); e.stopPropagation(); closeMenu(); onPick(); });
          return b;
        }
        async function openMenu(seat) {
          if (menuEl) return closeMenu();
          T = getT();
          const menu = document.createElement('div');
          menu.setAttribute(MENU_ATTR, '');
          menu.setAttribute('class', 'dms-menu');
          menu.setAttribute('role', 'menu');
          const rect = seat.getBoundingClientRect ? seat.getBoundingClientRect() : { left: 20, bottom: 20 };
          menu.style && (menu.style.left = `${rect.left}px`, menu.style.top = `${rect.bottom + 4}px`);
          menu.appendChild(menuItem(T.all, undefined, () => triggerSync(seat)));
          menu.appendChild(menuItem(T.preview, undefined, () => triggerSync(seat, undefined, true)));
          const hr = document.createElement('hr'); menu.appendChild(hr);
          const status = document.createElement('small'); status.textContent = T.loading; menu.appendChild(status);
          menuEl = menu; nodes.add(menu); document.body.appendChild(menu);
          const outside = (e) => { if (menuEl && !(e.target && menuEl.contains && menuEl.contains(e.target)) && e.target !== seat) closeMenu(); };
          const esc = (e) => { if (e.key === 'Escape') closeMenu(); };
          document.addEventListener && document.addEventListener('mousedown', outside, true);
          document.addEventListener && document.addEventListener('keydown', esc);
          menuOff = () => { document.removeEventListener && document.removeEventListener('mousedown', outside, true); document.removeEventListener && document.removeEventListener('keydown', esc); };
          try {
            const res = await fetch(REFRESH_PATH, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept-Language': acceptLanguage() },
              body: JSON.stringify({ action: 'list' }),
            });
            const data = await res.json().catch(() => ({}));
            if (menuEl !== menu || disposed) return;
            status.remove();
            const list = Array.isArray(data.providers) ? data.providers : [];
            if (list.length === 0) { const n = document.createElement('small'); n.textContent = T.none; menu.appendChild(n); }
            for (const p of list) menu.appendChild(menuItem(p.id, T.modelsHint(p.models), () => triggerSync(seat, p.id)));
          } catch (err) {
            if (menuEl === menu) status.textContent = localizeError(err.message);
          }
        }

        const CHEVRON_ICON =
          '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<polyline points="4 6 8 10 12 6" />' +
          '</svg>';

        function makeSeat({ tip, labeled, menuBtn }) {
          T = getT();
          const seat = document.createElement(labeled ? 'button' : 'span');
          seat.setAttribute(SEAT_ATTR, '');
          if (!labeled) seat.setAttribute('role', 'button');
          else seat.setAttribute('type', 'button');
          seat.setAttribute('tabindex', '0');
          seat.setAttribute('aria-label', tip);
          seat.title = tip;
          if (labeled) seat.classList.add('dms-labeled');
          if (menuBtn) seat.classList.add('dms-menu-btn');
          nodes.add(seat);

          const iconSpan = document.createElement('span');
          iconSpan.setAttribute('class', 'dms-icon');
          iconSpan.innerHTML = menuBtn ? CHEVRON_ICON : REFRESH_ICON;

          const spinSpan = document.createElement('span');
          spinSpan.setAttribute('class', 'dms-spin');
          spinSpan.innerHTML = SPINNER_ICON;

          seat.appendChild(iconSpan);
          if (labeled) {
            const label = document.createElement('span');
            label.setAttribute('class', 'dms-label');
            label.textContent = T.all;
            seat.appendChild(label);
          }
          seat.appendChild(spinSpan);
          return seat;
        }

        function createRefreshButton(targetHeader, mode = 'auto') {
          if (targetHeader.querySelector(`[${SEAT_ATTR}]`)) return;
          T = getT();

          if (mode === 'title') {
            const wrap = document.createElement('span');
            wrap.setAttribute('class', 'dms-title-actions');
            nodes.add(wrap);

            const allBtn = makeSeat({ tip: T.tipAll, labeled: true });
            const menuBtn = makeSeat({ tip: T.tipMenu, menuBtn: true });
            menuBtn.setAttribute('aria-haspopup', 'menu');

            const goAll = (e) => {
              e.preventDefault();
              e.stopPropagation();
              triggerSync(allBtn);
            };
            const goMenu = (e) => {
              e.preventDefault();
              e.stopPropagation();
              openMenu(menuBtn);
            };
            listen(allBtn, 'click', goAll);
            listen(allBtn, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') goAll(e); });
            listen(menuBtn, 'click', goMenu);
            listen(menuBtn, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') goMenu(e); });

            wrap.appendChild(allBtn);
            wrap.appendChild(menuBtn);
            targetHeader.appendChild(wrap);
            return;
          }

          const route0 = detectProviderKey(targetHeader);
          const tip = route0 ? T.tipOne(route0) : T.tipAll;
          const seat = makeSeat({ tip });

          const handleClick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const route = detectProviderKey(targetHeader);
            // Per-provider: still pulls that gateway's FULL /models list.
            triggerSync(seat, route);
          };

          listen(seat, 'click', handleClick);
          listen(seat, 'keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') handleClick(e);
          });

          const firstTarget = targetHeader.querySelector('button, svg, [data-dsh-part="chevron"], [aria-expanded]');
          if (firstTarget && firstTarget.parentElement === targetHeader) {
            targetHeader.insertBefore(seat, firstTarget);
          } else {
            targetHeader.appendChild(seat);
          }
        }

        function scanAndMount() {
          if (disposed) return;
          injectStyles();

          // Strategy 1: Models section title — visible labeled "全量刷新" + menu
          const sectionTitles = document.querySelectorAll(
            '[class*="_section"] > h2[class*="_title"], [class*="_title"], h2'
          );
          sectionTitles.forEach((h2) => {
            const label = (h2.childNodes && h2.childNodes[0] && h2.childNodes[0].textContent)
              ? h2.childNodes[0].textContent.trim()
              : (h2.textContent || '').replace(/全量刷新|Refresh all/g, '').trim();
            // Match bare title text even after we inject controls into the h2
            const bare = label.split('\n')[0].trim();
            if (bare === '模型' || bare === 'Models' || (h2.textContent || '').trim().startsWith('模型') || (h2.textContent || '').trim().startsWith('Models')) {
              if (!h2.querySelector('.dms-title-actions')) createRefreshButton(h2, 'title');
            }
          });

          // Strategy 2: custom provider rows — per-provider full /models pull
          const rowActions = document.querySelectorAll(
            '[class*="_rowCard"] [class*="_rowActions"], [class*="_rowHead"] [class*="_rowActions"]'
          );
          rowActions.forEach((actions) => {
            const rowCard = actions.closest?.('li, [class*="_rowCard"], [class*="_rowHead"]');
            const hasCustomTag = rowCard?.querySelector?.('[class*="_rowTag"]');
            const hasRemoveBtn = actions.querySelector?.('button[class*="_dangerButton"], button[aria-label*="remove"], button[aria-label*="删除"]');
            if (hasCustomTag || hasRemoveBtn) {
              createRefreshButton(actions);
            }
          });

          // Strategy 3: Provider editor model catalog heading
          const catalogHeadings = document.querySelectorAll(
            '[class*="_modelListHead"] [class*="_modelCatalogHeading"]'
          );
          catalogHeadings.forEach(createRefreshButton);

          // Strategy 4: Legacy / capability headers
          const otherHeaders = document.querySelectorAll(
            'section[data-dsh-plugin="model-capabilities"] button[data-dsh-part="toggle"], ' +
            'section[data-dsh-part="panel"] button[data-dsh-part="toggle"], ' +
            '[data-dsh-models-header], ' +
            '[data-dsh-settings-section="models"] [data-dsh-provider-card] h3, ' +
            '[data-dsh-settings-section="models"] [data-dsh-provider-card] header'
          );
          otherHeaders.forEach(createRefreshButton);
        }

        const observer = new MutationObserver(scanAndMount);

        function remountForLocale() {
          if (disposed) return;
          closeMenu();
          for (const node of [...nodes]) {
            try {
              if (node && node.getAttribute && (
                node.getAttribute(SEAT_ATTR) !== null
                || node.getAttribute(MENU_ATTR) !== null
                || (node.getAttribute('class') || '').includes('dms-title-actions')
              )) {
                node.remove();
                nodes.delete(node);
              }
            } catch { /* ignore */ }
          }
          T = getT();
          scanAndMount();
        }

        let offLocale = null;
        try {
          if (ctx.locale && typeof ctx.locale.subscribe === 'function') {
            offLocale = ctx.locale.subscribe(() => remountForLocale());
          }
        } catch { offLocale = null; }

        ctx.effect(() => () => {
          disposed = true;
          observer.disconnect();
          if (typeof offLocale === 'function') offLocale();
          closeMenu();
          for (const timer of timers) clearTimeout(timer);
          timers.clear();
          for (const unlisten of listeners) unlisten();
          listeners.clear();
          for (const node of nodes) node.remove();
          nodes.clear();
        });
        scanAndMount();
        observer.observe(document.body, { childList: true, subtree: true });
        },
      }),
    });
  } catch (err) {
    console.warn('[dsh-model-sync] Client initialization error:', err);
  }
})();
