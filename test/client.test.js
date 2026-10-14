import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function fixture() {
  const nodes = [];
  const observers = [];
  const timers = new Map();
  let registration;
  let requests = 0;
  let resolveFetch;

  class Element {
    constructor(tag) {
      this.tag = tag;
      this.attributes = {};
      this.children = [];
      this.listeners = new Map();
      this.parentElement = null;
      this.classes = new Set();
      this.classList = {
        contains: (value) => this.classes.has(value),
        add: (value) => this.classes.add(value),
        remove: (value) => this.classes.delete(value),
      };
      nodes.push(this);
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    appendChild(node) { node.parentElement = this; this.children.push(node); }
    insertBefore(node, ref) {
      node.parentElement = this;
      const index = this.children.indexOf(ref);
      if (index === -1) this.children.push(node);
      else this.children.splice(index, 0, node);
    }
    closest(selector) {
      for (let curr = this; curr; curr = curr.parentElement) {
        if (selector.includes(curr.tag)) return curr;
        const cls = curr.attributes.class || '';
        if (selector.includes('_rowCard') && cls.includes('_rowCard')) return curr;
        if (selector.includes('_rowHead') && cls.includes('_rowHead')) return curr;
      }
      return null;
    }
    querySelector(selector) {
      const match = (node) => {
        if (selector === '[data-dsh-model-sync-refresh]' && 'data-dsh-model-sync-refresh' in node.attributes) return true;
        const cls = node.attributes.class || '';
        if (selector.includes('_rowTag') && cls.includes('_rowTag')) return true;
        if (selector.includes('_rowName') && cls.includes('_rowName')) return true;
        if (selector.includes('_dangerButton') && cls.includes('_dangerButton')) return true;
        if (selector === 'button' && node.tag === 'button') return true;
        return false;
      };
      const walk = (parent) => {
        for (const child of parent.children) {
          if (match(child)) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
        this.parentElement = null;
      }
    }
    click() {
      for (const listener of this.listeners.get('click') || []) {
        listener({ preventDefault() {}, stopPropagation() {} });
      }
    }
  }

  const head = new Element('head');
  const body = new Element('body');
  const header = new Element('header');
  body.appendChild(header);

  // DSH Desktop Models section structure
  const modelsSection = new Element('div');
  modelsSection.setAttribute('class', '_5M2yiq_section');
  const modelsTitle = new Element('h2');
  modelsTitle.setAttribute('class', '_5M2yiq_title');
  modelsTitle.textContent = '模型';
  modelsSection.appendChild(modelsTitle);

  // Non-custom row: DeepSeek
  const deepseekRow = new Element('li');
  deepseekRow.setAttribute('class', '_5M2yiq_rowCard');
  const deepseekHead = new Element('div');
  deepseekHead.setAttribute('class', '_5M2yiq_rowHead');
  const deepseekName = new Element('span');
  deepseekName.setAttribute('class', '_5M2yiq_rowName');
  deepseekName.textContent = 'DeepSeek';
  const deepseekActions = new Element('span');
  deepseekActions.setAttribute('class', '_5M2yiq_rowActions');
  const deepseekEdit = new Element('button');
  deepseekEdit.textContent = '编辑';
  deepseekActions.appendChild(deepseekEdit);
  deepseekHead.appendChild(deepseekName);
  deepseekHead.appendChild(deepseekActions);
  deepseekRow.appendChild(deepseekHead);
  modelsSection.appendChild(deepseekRow);

  // Custom row: grok
  const grokRow = new Element('li');
  grokRow.setAttribute('class', '_5M2yiq_rowCard');
  const grokHead = new Element('div');
  grokHead.setAttribute('class', '_5M2yiq_rowHead');
  const grokName = new Element('span');
  grokName.setAttribute('class', '_5M2yiq_rowName');
  grokName.textContent = 'grok';
  const grokTag = new Element('span');
  grokTag.setAttribute('class', '_5M2yiq_rowTag');
  grokTag.textContent = '自定义';
  const grokActions = new Element('span');
  grokActions.setAttribute('class', '_5M2yiq_rowActions');
  const grokEdit = new Element('button');
  grokEdit.textContent = '编辑';
  grokActions.appendChild(grokEdit);
  grokHead.appendChild(grokName);
  grokHead.appendChild(grokTag);
  grokHead.appendChild(grokActions);
  grokRow.appendChild(grokHead);
  modelsSection.appendChild(grokRow);

  body.appendChild(modelsSection);

  let lastPayload;
  const document = {
    head, body,
    createElement: (tag) => new Element(tag),
    querySelector: (selector) => nodes.find((node) => node.parentElement
      && selector === `[${Object.keys(node.attributes)[0]}]`) || null,
    querySelectorAll: (selector) => {
      const results = [];
      if (selector.includes('[data-dsh-models-header]')) results.push(header);
      if (selector.includes('h2') || selector.includes('[class*="_title"]')) results.push(modelsTitle);
      if (selector.includes('[class*="_rowActions"]')) {
        results.push(deepseekActions, grokActions);
      }
      return results;
    },
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { registration = value; } } },
    document,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
      observe() { this.connected = true; }
      disconnect() { this.connected = false; }
    },
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      requests += 1;
      lastPayload = options?.body ? JSON.parse(options.body) : {};
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
    console,
  };
  vm.runInNewContext(source, sandbox);
  const plugin = registration.factory();
  return {
    plugin, header, head, body, observers, timers, modelsTitle, grokActions, deepseekActions,
    requests: () => requests,
    lastPayload: () => lastPayload,
    finishFetch: () => resolveFetch({ ok: true, json: async () => ({ ok: true, results: [] }) }),
    mount() {
      const disposers = [];
      const cleanup = plugin.apply({ effect(setup) {
        disposers.push(setup());
      } });
      if (typeof cleanup === 'function') disposers.push(cleanup);
      return () => disposers.forEach((dispose) => dispose());
    },
  };
}

test('client factory exports a Cordis plugin without mounting DOM eagerly', () => {
  const f = fixture();
  assert.equal(typeof f.plugin?.apply, 'function');
  assert.equal(f.head.children.length, 0);
  assert.equal(f.observers.length, 0);
  assert.equal(f.header.children.length, 0);
});

test('client mounts on apply and cleans nodes, listeners, observer and timers on dispose', async () => {
  const f = fixture();
  assert.equal(typeof f.plugin?.apply, 'function');
  const dispose = f.mount();
  const button = f.header.querySelector('[data-dsh-model-sync-refresh]');
  assert.ok(button);
  assert.equal(f.head.children.length, 1);
  assert.equal(f.observers[0].connected, true);
  f.observers[0].callback();
  assert.equal(f.header.children.length, 1);
  button.click();
  assert.equal(f.requests(), 1);
  f.finishFetch();
  await new Promise(setImmediate);
  assert.equal(f.timers.size, 1);
  dispose();
  assert.equal(f.header.children.length, 0);
  assert.equal(f.head.children.length, 0);
  assert.equal(f.body.children.length, 2);
  assert.equal(f.observers[0].connected, false);
  assert.equal(f.timers.size, 0);
  button.click();
  assert.equal(f.requests(), 1);
});

test('client can remount without duplicate buttons or stale observers', () => {
  const f = fixture();
  assert.equal(typeof f.plugin?.apply, 'function');
  f.mount()();
  const dispose = f.mount();
  assert.equal(f.header.children.length, 1);
  assert.equal(f.head.children.length, 1);
  assert.equal(f.observers.filter((observer) => observer.connected).length, 1);
  dispose();
});

test('pending refresh cannot recreate toasts after plugin disposal', async () => {
  const f = fixture();
  assert.equal(typeof f.plugin?.apply, 'function');
  const dispose = f.mount();
  f.header.querySelector('[data-dsh-model-sync-refresh]').click();
  dispose();
  f.finishFetch();
  await new Promise(setImmediate);
  assert.equal(f.body.children.length, 2);
  assert.equal(f.timers.size, 0);
});

test('mounts refresh button on DSH Desktop models title and custom provider rows', async () => {
  const f = fixture();
  const dispose = f.mount();

  const titleBtn = f.modelsTitle.querySelector('[data-dsh-model-sync-refresh]');
  assert.ok(titleBtn, 'modelsTitle should have refresh button');

  const grokBtn = f.grokActions.querySelector('[data-dsh-model-sync-refresh]');
  assert.ok(grokBtn, 'custom provider grok should have refresh button');

  const deepseekBtn = f.deepseekActions.querySelector('[data-dsh-model-sync-refresh]');
  assert.equal(deepseekBtn, null, 'non-custom deepseek row should not have refresh button');

  // Click title button -> triggers global sync (no route)
  titleBtn.click();
  assert.deepEqual(f.lastPayload(), {});

  // Click grok button -> triggers route sync
  grokBtn.click();
  assert.deepEqual(f.lastPayload(), { route: 'grok' });

  dispose();
});
