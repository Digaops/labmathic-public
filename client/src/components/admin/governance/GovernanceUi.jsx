import { AlertCircle, Check, ShieldAlert } from 'lucide-react';

export const releaseStatus = {
  draft: { label: 'Rascunho', className: 'bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-slate-200' },
  pilot: { label: 'Piloto', className: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200' },
  rolling_out: { label: 'Liberação gradual', className: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200' },
  general: { label: 'Disponível para todos', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200' },
  paused: { label: 'Pausada', className: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200' },
  retired: { label: 'Encerrada', className: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-600/30 dark:text-neutral-200' },
};

export const releaseTransitions = {
  draft: ['draft', 'pilot', 'retired'],
  pilot: ['pilot', 'rolling_out', 'paused', 'retired'],
  rolling_out: ['rolling_out', 'general', 'paused', 'retired'],
  general: ['general', 'paused', 'retired'],
  paused: ['paused', 'pilot', 'rolling_out', 'general', 'retired'],
  retired: ['retired'],
};

export function StatusBadge({ status }) {
  const config = releaseStatus[status] || releaseStatus.draft;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-black ${config.className}`}>
      {config.label}
    </span>
  );
}

export function Field({ label, hint, required = false, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-black text-neutral-700 dark:text-neutral-200">
        {label}{required ? <span className="ml-1 text-red-500">*</span> : null}
      </span>
      {children}
      {hint ? <span className="mt-1.5 block text-[11px] font-medium leading-relaxed text-neutral-500 dark:text-neutral-400">{hint}</span> : null}
    </label>
  );
}

export function ReasonField({ value, onChange, label = 'Motivo da alteração' }) {
  const length = value.trim().length;
  return (
    <Field
      label={label}
      hint="Obrigatório para auditoria. Informe de forma objetiva o motivo e o resultado esperado."
      required
    >
      <textarea
        className="input min-h-24 resize-y"
        value={value}
        maxLength={500}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Ex.: liberar somente para professores selecionados durante a validação inicial."
      />
      <span className={`mt-1 block text-right text-[10px] font-bold ${length > 0 && length < 10 ? 'text-red-500' : 'text-neutral-400'}`}>
        {length}/500 · mínimo 10
      </span>
    </Field>
  );
}

export function Toggle({ checked, onChange, label, description, danger = false, disabled = false }) {
  return (
    <label className={`flex items-start gap-3 rounded-2xl border p-3.5 transition-colors ${
      checked
        ? danger
          ? 'border-red-300 bg-red-50/80 dark:border-red-500/30 dark:bg-red-500/10'
          : 'border-primary-300 bg-primary-50/70 dark:border-cyan-400/25 dark:bg-cyan-400/10'
        : 'border-neutral-200 bg-white dark:border-white/10 dark:bg-white/5'
    } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border ${
        checked
          ? danger ? 'border-red-500 bg-red-500 text-white' : 'border-primary-500 bg-primary-500 text-white'
          : 'border-neutral-300 bg-white dark:border-neutral-500 dark:bg-neutral-800'
      }`}>
        {checked ? <Check size={13} strokeWidth={3} /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-black text-neutral-800 dark:text-neutral-100">{label}</span>
        {description ? <span className="mt-0.5 block text-xs font-medium leading-relaxed text-neutral-500 dark:text-neutral-400">{description}</span> : null}
      </span>
    </label>
  );
}

export function ApiError({ message }) {
  if (!message) return null;
  return (
    <div className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-bold text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200" role="alert">
      <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
      <span>{message}</span>
    </div>
  );
}

export function ModalActions({ onCancel, saving, submitLabel = 'Salvar alteração', danger = false, disabled = false }) {
  return (
    <div className="mt-5 flex flex-col-reverse gap-2 border-t border-neutral-100 pt-4 dark:border-white/10 sm:flex-row sm:justify-end">
      <button type="button" className="btn-ghost justify-center" onClick={onCancel} disabled={saving}>
        Cancelar
      </button>
      <button
        type="submit"
        className={`${danger ? 'inline-flex items-center justify-center rounded-xl bg-red-600 px-4 py-2.5 text-sm font-black text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50' : 'btn-primary justify-center'}`}
        disabled={saving || disabled}
      >
        {saving ? 'Salvando...' : submitLabel}
      </button>
    </div>
  );
}

export function SafetyNote({ children, danger = false }) {
  return (
    <div className={`flex gap-2.5 rounded-2xl border p-3.5 text-xs font-semibold leading-relaxed ${
      danger
        ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100'
        : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100'
    }`}>
      <ShieldAlert size={17} className="mt-0.5 flex-shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function apiErrorMessage(error) {
  return error?.response?.data?.error || 'Não foi possível concluir a operação. Tente novamente.';
}

export function formatDate(value) {
  if (!value) return 'Ainda não registrada';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
