import { useId } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export const demoPanel = 'rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#111e31] sm:p-4';

export function DemoHeader({ title, children }) {
  const { user } = useAuth();
  return <header className="space-y-1">
    <h1 className="text-2xl font-bold">{title}</h1>
    <p className="text-sm"><strong>Demonstração.</strong> Exemplos inventados, sem gravação ou envio aos estudantes.</p>
    <nav aria-label="Sair dos exemplos" className="flex flex-wrap gap-2 pt-1">
      <Link className="btn-outline" to="/banco-questoes">Abrir banco de questões</Link>
      {user?.role === 'professor' && <Link className="btn-outline" to="/banco-questoes/devolutivas">Trabalhar com minhas turmas</Link>}
    </nav>
    {children}
  </header>;
}

export function DemoSelect({ label, value, onChange, options, disabled = false }) {
  const id = useId();
  return <div className="min-w-0 text-sm">
    <label htmlFor={id} className="mb-1 block font-semibold">{label}</label>
    <select id={id} className="input w-full" value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>;
}

export function DemoReadState({ resource }) {
  if (resource.loading) return <p role="status" className="py-3 text-sm">Carregando exemplos…</p>;
  if (!resource.error) return null;
  return <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-400/10 dark:text-amber-100">
    <p>{resource.error}</p><button type="button" className="btn-outline mt-2" onClick={resource.retry}>Tentar novamente</button>
  </div>;
}

export function DemoPrintState({ className }) {
  return <section className={className}><h1>LabMathic · Demonstração</h1><p>Não há um exemplo pronto para impressão. Aguarde o carregamento ou tente novamente na tela.</p></section>;
}
