// The view has a sink for notifications. Only components can forward them.
class PassiveView {
  #bindings = new WeakMap();
  #notify;

  constructor(scope, notify) {
    this.scope = scope;
    this.#notify = notify;
  }

  find(id) {
    return this.scope.getElementById?.(id) ?? this.scope.querySelector('#' + CSS.escape(id));
  }

  all(selector) {
    return this.scope.querySelectorAll(selector);
  }

  create(tag) {
    return document.createElement(tag);
  }

  readForm(form) {
    return Object.fromEntries(new FormData(form));
  }

  confirm(message) {
    return window.confirm(message);
  }

  prompt(message) {
    return window.prompt(message);
  }

  copy(text) {
    return navigator.clipboard.writeText(text);
  }

  download(text, filename) {
    const url = URL.createObjectURL(new Blob(['\ufeff', text], { type: 'text/plain;charset=utf-8' }));
    const link = this.create('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  render(parameters) {
    for (const [id, { html, text, ...properties }] of Object.entries(parameters)) {
      const element = this.find(id);
      if (html !== undefined) element.innerHTML = html;
      if (text !== undefined) element.textContent = text;
      Object.assign(element, properties);
    }
  }

  observeUnload() {
    window.addEventListener('beforeunload', (event) => {
      if (this.#notify('beforeUnload')) event.preventDefault();
    });
  }

  bind(element, type, action) {
    let bindings = this.#bindings.get(element);
    if (!bindings) this.#bindings.set(element, (bindings = new Map()));
    if (!bindings.has(type)) {
      element.addEventListener(type, (event) => {
        if (type === 'submit') event.preventDefault();
        const input = {
          type,
          target: event.target,
          currentTarget: element,
          shiftKey: event.shiftKey,
        };
        for (const token of bindings.get(type)) this.#notify(token, input);
      });
      bindings.set(type, new Set());
    }
    bindings.get(type).add(action);
  }
}

export class Component {
  #actions = new WeakMap();
  #children = new Map();

  constructor(scope, parent = null, dispatch = null) {
    this.parent = parent;
    this.dispatch = dispatch;
    this.view = new PassiveView(scope, (type, detail) => this.emit(type, detail));
  }

  child(name, scope) {
    const existing = this.#children.get(name);
    if (existing) return existing;
    const child = new Component(scope, this);
    this.#children.set(name, child);
    return child;
  }

  on(element, type, key, handler) {
    // Dynamic rows share an action name but have independent input contexts.
    let actions = this.#actions.get(element);
    if (!actions) this.#actions.set(element, (actions = new Map()));
    actions.set(key, handler);
    this.view.bind(element, type, key);
  }

  emit(type, detail) {
    return this.route({ source: this, type, detail });
  }

  route(event) {
    if (this.parent) return this.parent.route(event);
    return this.dispatch(event);
  }

  handler(type, input) {
    return this.#actions.get(input?.currentTarget)?.get(type);
  }
}
