// Shared range and bulk selection for purchase and allocation tables.
export class Selection {
  #values = new Map();
  #visible = [];
  #anchor = null;
  #viewKey;

  get size() {
    return this.#values.size;
  }
  has(id) {
    return this.#values.has(id);
  }
  get(id) {
    return this.#values.get(id);
  }
  set(id, value) {
    this.#values.set(id, value);
  }
  ids() {
    return this.#values.keys();
  }
  entries() {
    return this.#values.entries();
  }
  values() {
    return this.#values.values();
  }

  clear() {
    this.#values.clear();
    this.#anchor = null;
  }

  update(candidates, visible, key) {
    const valid = new Set(candidates.map((row) => row.id));
    for (const id of this.ids()) if (!valid.has(id)) this.#values.delete(id);
    this.#visible = visible.map((row) => row.id);
    const viewKey = JSON.stringify([key, this.#visible]);
    if (this.#viewKey !== viewKey) this.#anchor = null;
    this.#viewKey = viewKey;
  }

  toggle(id, checked, range, defaultValue) {
    const from = this.#visible.indexOf(this.#anchor);
    const to = this.#visible.indexOf(id);
    const targets =
      range && from >= 0 && to >= 0 ? this.#visible.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
    this.#apply(targets, checked, defaultValue);
    this.#anchor = id;
  }

  bulk(checked, defaultValue) {
    this.#anchor = null;
    this.#apply(this.#visible, checked, defaultValue);
  }

  #apply(ids, checked, defaultValue) {
    for (const id of ids) {
      if (!checked) this.#values.delete(id);
      else if (!this.has(id)) this.set(id, defaultValue?.(id));
    }
  }

  summary() {
    const total = this.#visible.length;
    const selected = this.#visible.filter((id) => this.has(id)).length;
    return { total, selected, outside: this.size - selected };
  }
}
