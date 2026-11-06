// 邮件页面提取器的离线 DOM：测试不启动浏览器、不访问外部邮箱。
const vm = require('node:vm');

class Element {
  constructor({ tag = '', attrs = {}, children = [] }, parent = null) {
    this.tag = tag; this.attrs = attrs; this.parent = parent;
    this.children = children.map(child => typeof child === 'string' ? child : new Element(child, this));
  }
  get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.children = [value]; }
  append(...values) { this.children.push(...values); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  cloneNode() { return new Element(this.toJSON()); }
  toJSON() { return { tag: this.tag, attrs: this.attrs, children: this.children.map(child => typeof child === 'string' ? child : child.toJSON()) }; }
  remove() { this.replaceWith(); }
  replaceWith(...values) { this.parent.children.splice(this.parent.children.indexOf(this), 1, ...values); }
  matches(selector) {
    if (selector.startsWith('.')) return (this.attrs.class || '').split(/\s+/).includes(selector.slice(1));
    const [, tag, attr] = selector.match(/^([^\[]*)?(?:\[([^\]]+)\])?$/);
    return (!tag || tag === this.tag) && (!attr || Object.hasOwn(this.attrs, attr));
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim());
    return this.children.flatMap(child => typeof child === 'string' ? [] : [
      ...(selectors.some(value => child.matches(value)) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function evaluateArticles(fn, fixture) {
  const document = { createElement(tag) {
    if (tag !== 'template') throw new Error('unexpected element');
    return {
      content: new Element({}),
      set innerHTML(html) {
        const frame = fixture.frames?.[html];
        if (!frame) throw new Error('missing fixture frame');
        this.content = new Element(frame);
      },
    };
  } };
  return vm.runInNewContext(`(${fn.toString()})(articles)`, { document, articles: fixture.articles.map(value => new Element(value)) });
}

module.exports = { evaluateArticles };
