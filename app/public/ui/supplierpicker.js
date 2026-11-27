export function supplierPicker(parent, container, getSuppliers) {
  const component = parent.child(container.id, container);
  const view = component.view;
  const search = view.scope.querySelector('[role=combobox]');
  const options = view.scope.querySelector('[role=listbox]');
  const count = view.scope.querySelector('[role=status]');
  const supplierId = view.scope.querySelector('[name=supplier_id]');
  const supplierLabel = (supplier) => supplier.code + ' ' + supplier.name;
  const normalized = (value) => value.normalize('NFKC').trim().toLowerCase();
  const selectedSupplier = () => getSuppliers().find((row) => String(row.id) === supplierId.value);
  let activeOption = -1;

  function closeSupplierOptions() {
    options.hidden = true;
    search.setAttribute('aria-expanded', 'false');
    search.removeAttribute('aria-activedescendant');
    activeOption = -1;
  }
  function setSupplierValidity() {
    const selected = selectedSupplier();
    search.setCustomValidity(
      selected && search.value === supplierLabel(selected) ? '' : '仕入先を候補から選択してください',
    );
  }
  function selectSupplier(supplier) {
    const changed = supplierId.value !== String(supplier.id);
    supplierId.value = supplier.id;
    search.value = supplierLabel(supplier);
    setSupplierValidity();
    count.textContent = '';
    closeSupplierOptions();
    if (changed) supplierId.dispatchEvent(new Event('change'));
  }
  function renderSupplierOptions() {
    if (document.activeElement !== search) return;
    const terms = normalized(
      selectedSupplier() && search.value === supplierLabel(selectedSupplier()) ? '' : search.value,
    )
      .split(/\s+/)
      .filter(Boolean);
    const matches = getSuppliers().filter((supplier) =>
      terms.every((term) => normalized(supplierLabel(supplier)).includes(term)),
    );
    options.replaceChildren();
    activeOption = -1;
    search.removeAttribute('aria-activedescendant');
    for (const supplier of matches) {
      const option = view.create('button');
      option.type = 'button';
      option.id = options.id + '-' + supplier.id;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(String(supplier.id) === supplierId.value));
      option.tabIndex = -1;
      option.textContent = supplierLabel(supplier);
      component.on(option, 'mousedown', 'keepSupplierFocus', (input) => input.preventDefault());
      component.on(option, 'click', 'chooseSupplier', () => selectSupplier(supplier));
      options.append(option);
    }
    options.hidden = !matches.length;
    search.setAttribute('aria-expanded', String(!options.hidden));
    count.textContent = terms.length ? matches.length + '件一致' : '';
  }
  component.on(search, 'focus', 'openSupplierOptions', renderSupplierOptions);
  component.on(search, 'blur', 'closeSupplierOptions', closeSupplierOptions);
  component.on(search, 'input', 'filterInvoiceSuppliers', () => {
    // Keep any existing selection until another supplier is chosen, so corrections do not clear row choices.
    setSupplierValidity();
    renderSupplierOptions();
  });
  component.on(search, 'keydown', 'moveSupplierFocus', (input) => {
    if (input.isComposing) return;
    if (input.key === 'Escape') {
      const selected = selectedSupplier();
      if (selected) selectSupplier(selected);
      closeSupplierOptions();
      input.preventDefault();
      return;
    }
    if (input.key === 'Enter' && !options.hidden) {
      input.preventDefault();
      const option =
        options.children[activeOption] ?? (options.children.length === 1 ? options.firstChild : null);
      option?.click();
      return;
    }
    if (input.key !== 'ArrowDown' && input.key !== 'ArrowUp') return;
    input.preventDefault();
    if (options.hidden) renderSupplierOptions();
    if (!options.children.length) return;
    const length = options.children.length;
    activeOption =
      activeOption < 0
        ? input.key === 'ArrowDown'
          ? 0
          : length - 1
        : (activeOption + (input.key === 'ArrowDown' ? 1 : -1) + length) % length;
    for (const [index, option] of Array.from(options.children).entries()) {
      option.setAttribute('aria-selected', String(index === activeOption));
    }
    const option = options.children[activeOption];
    search.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest' });
  });
  setSupplierValidity();
  return {
    input: search,
    refresh() {
      setSupplierValidity();
      if (!options.hidden) renderSupplierOptions();
    },
    restoreSelection() {
      const supplier = selectedSupplier();
      search.value = supplier ? supplierLabel(supplier) : '';
      count.textContent = '';
      closeSupplierOptions();
      setSupplierValidity();
    },
  };
}
