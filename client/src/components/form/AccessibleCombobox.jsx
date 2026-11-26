import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';

const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');

function nextEnabled(options, start, direction) {
  if (!options.length) return -1;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (start + (offset * direction) + options.length) % options.length;
    if (!options[index].disabled) return index;
  }
  return -1;
}

export default function AccessibleCombobox({
  id,
  value,
  options = [],
  onChange,
  onQueryChange,
  placeholder = 'Selecione',
  searchPlaceholder = 'Digite para buscar',
  emptyMessage = 'Nenhuma opção encontrada.',
  loading = false,
  disabled = false,
  required = false,
  searchable = true,
  remote = false,
}) {
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const selected = options.find((option) => String(option.value) === String(value)) || null;
  const visibleOptions = useMemo(() => {
    if (remote || !searchable || !query.trim()) return options;
    const normalized = normalize(query);
    return options.filter((option) => normalize(`${option.label} ${option.description || ''}`).includes(normalized));
  }, [options, query, remote, searchable]);
  const listboxId = `${id}-listbox`;

  useEffect(() => {
    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
        setQuery('');
        setActiveIndex(-1);
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  useEffect(() => {
    setActiveIndex((current) => {
      if (!visibleOptions.length) return -1;
      if (current >= 0 && current < visibleOptions.length && !visibleOptions[current].disabled) return current;
      return visibleOptions.findIndex((option) => !option.disabled);
    });
  }, [visibleOptions]);

  useEffect(() => {
    const list = listRef.current, option = list?.querySelector('[id="' + listboxId + '-option-' + activeIndex + '"]');
    if (!open || !list || !option) return;
    const box = option.getBoundingClientRect(), viewport = list.getBoundingClientRect();
    if (box.top < viewport.top) list.scrollTop -= viewport.top - box.top;
    else if (box.bottom > viewport.bottom) list.scrollTop += box.bottom - viewport.bottom;
  }, [activeIndex, open, listboxId]);

  const choose = (option) => {
    if (!option || option.disabled || loading || disabled || inputRef.current?.matches(':disabled')) return;
    onChange?.(option.value, option);
    setOpen(false);
    setQuery('');
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const openList = () => {
    if (disabled || inputRef.current?.matches(':disabled')) return;
    setOpen(true);
    setActiveIndex(visibleOptions.findIndex((option) => !option.disabled));
  };

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      setActiveIndex((current) => nextEnabled(
        visibleOptions,
        current < 0 ? (event.key === 'ArrowDown' ? -1 : 0) : current,
        event.key === 'ArrowDown' ? 1 : -1,
      ));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!open) {
        event.preventDefault();
        openList();
      } else if (activeIndex >= 0) {
        event.preventDefault();
        choose(visibleOptions[activeIndex]);
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation();
      setOpen(false);
      setQuery('');
      setActiveIndex(-1);
    } else if (event.key === 'Tab') {
      setOpen(false);
      setQuery('');
    }
  };

  const displayValue = open && searchable ? query : (selected?.label || '');
  return (
    <div ref={rootRef} className="relative mt-2">
      <div className={`flex w-full items-center rounded-xl border bg-white transition focus-within:border-cyan-500 focus-within:ring-2 focus-within:ring-cyan-500/20 dark:bg-[#1b2a3e] ${
        open ? 'border-cyan-500' : 'border-neutral-200 dark:border-white/10'
      } ${disabled ? 'cursor-not-allowed opacity-55' : ''}`}>
        <input
          ref={inputRef}
          id={id}
          className="min-h-11 min-w-0 flex-1 rounded-xl bg-transparent px-3 py-2.5 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-white"
          role="combobox"
          aria-autocomplete={searchable ? 'list' : 'none'}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
          aria-required={required || undefined}
          autoComplete="off"
          disabled={disabled}
          readOnly={!searchable}
          placeholder={open && searchable ? searchPlaceholder : placeholder}
          value={displayValue}
          onFocus={openList}
          onClick={openList}
          onChange={(event) => {
            const nextQuery = event.target.value;
            setQuery(nextQuery);
            setActiveIndex(-1);
            setOpen(true);
            onQueryChange?.(nextQuery);
          }}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-white/10"
          aria-label={open ? 'Fechar opções' : 'Abrir opções'}
          disabled={disabled}
          tabIndex={-1}
          onClick={() => (open ? setOpen(false) : openList())}
        >
          {loading ? <Loader2 className="animate-spin" size={17} /> : <ChevronDown className={open ? 'rotate-180 transition' : 'transition'} size={18} />}
        </button>
      </div>

      {!open && selected && <p className="mt-1 break-words text-xs font-normal leading-5 text-slate-600 dark:text-slate-300">{selected.label}{selected.description ? ` · ${selected.description}` : ''} </p>}
      {open && (
        <div className="relative z-10 mt-2 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl shadow-slate-950/20 dark:border-white/10 dark:bg-[#17263a]" data-combobox-popup>
          <ul ref={listRef} id={listboxId} role="listbox" aria-label="Opções disponíveis" className="max-h-64 overflow-y-auto p-1.5">
            {loading && !visibleOptions.length ? (
              <li className="flex items-center gap-2 px-3 py-4 text-sm text-neutral-500 dark:text-neutral-300"><Loader2 className="animate-spin" size={16} /> Consultando…</li>
            ) : visibleOptions.length ? visibleOptions.map((option, index) => {
              const isSelected = String(option.value) === String(value);
              const isActive = activeIndex === index;
              return (
                <li
                  id={`${listboxId}-option-${index}`}
                  key={`${option.value}-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 text-sm ${
                    option.disabled
                      ? 'cursor-not-allowed text-neutral-600 dark:text-neutral-300'
                      : isActive
                        ? 'bg-cyan-50 text-cyan-950 dark:bg-cyan-400/10 dark:text-cyan-100'
                        : 'text-neutral-800 hover:bg-neutral-50 dark:text-neutral-100 dark:hover:bg-white/[0.06]'
                  }`}
                  onMouseMove={event => { if (!option.disabled && (event.movementX || event.movementY)) setActiveIndex(index); }}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => choose(option)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-bold">{option.label}</span>
                    {option.description && <span className="mt-0.5 block break-words text-xs text-neutral-600 dark:text-neutral-300">{option.description}</span>}
                  </span>
                  {isSelected && <Check className="mt-0.5 shrink-0 text-cyan-600 dark:text-cyan-300" size={17} />}
                </li>
              );
            }) : (
              <li className="px-3 py-4 text-sm leading-5 text-neutral-500 dark:text-neutral-300">{emptyMessage}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
