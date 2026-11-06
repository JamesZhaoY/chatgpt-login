// Import the production modules directly; no source slicing or rewritten globals.
async function frontend() {
  const modules = await Promise.all(['state', 'ui', 'filters', 'plans', 'editor', 'settings', 'accounts', 'tasks', 'navigation'].map(name => import(`../../public/js/${name}.mjs`)));
  const context = Object.assign({}, ...modules);
  Object.assign(context.app, { accounts: [], worker: { queue: [], inFlight: [], running: false }, selected: new Set(), openLogs: new Set(), openPlans: new Set(), busy: new Set(), openTasks: new Set(),
    filter: 'all', connected: false, loaded: false, editorRows: [], editorDirty: false, editorLoaded: false, editorBaseline: new Map(), editorExpectedContent: null, editorPage: 1, editorSearch: '', editorFilter: 'all',
    removedEditorRow: null, proxyConfig: null, proxyDirty: false, page: 1, pageSize: 12, view: 'accounts' });
  const elements = new Map();
  const defaults = { searchInput: '', sortSelect: 'default', planFilter: 'all' };
  const makeElement = () => ({ value: '', hidden: true, checked: false, selectedOptions: [], innerHTML: '', textContent: '', children: [], dataset: {}, handlers: {}, attributes: {},
    classList: { toggle() {} }, addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
    focus() {}, scrollIntoView() {}, querySelectorAll: () => [], querySelector: () => null, closest: () => null,
    reset() { for (const id of ['quickAccountEmail', 'quickAccountMailUrl', 'quickAccountPassword', 'quickAccountTwofa']) { const input = elements.get('#' + id); if (input) input.value = ''; } },
    showModal() { this.open = true; }, close() { this.open = false; for (const handler of this.handlers.close || []) handler(); },
    replaceChildren() { this.children = []; }, insertBefore(node, before) {
      if (node.parentNode) node.remove();
      const i = before ? this.children.indexOf(before) : -1;
      this.children.splice(i < 0 ? this.children.length : i, 0, node); node.parentNode = this;
    }, remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; },
  });
  const document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, { ...makeElement(), value: defaults[selector.slice(1)] || '' });
    return elements.get(selector);
  }, querySelectorAll: () => [], addEventListener() {}, createElement: makeElement, activeElement: { closest: () => null, dataset: {}, isConnected: true, focus() {} }, documentElement: { dataset: {} } };
  global.document = document;
  global.requestAnimationFrame = () => 1;
  for (const id of Object.keys(defaults)) document.querySelector('#' + id);
  return { context, elements, controls: Object.fromEntries(elements), document, matches: context.matchesMembership };
}

module.exports = { frontend };
