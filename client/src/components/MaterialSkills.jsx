import useHomeResource from '../hooks/useHomeResource';
import MaterialResourceState from './MaterialResourceState';
import { associationLabel, publicAssociations } from '../services/materialCurationView.mjs';
export default function MaterialSkills({ id, identity }) {
  const result = useHomeResource(`/materials/curation/materials/${id}/skills`, identity, publicAssociations);
  return <section aria-label="Habilidades relacionadas" className="space-y-2 text-sm text-slate-800 dark:text-slate-200"><h2 className="font-bold">Habilidades relacionadas</h2><MaterialResourceState resource={result} label="as habilidades do material" />{result.status === 'ready' && <>
    {!result.data.associations.length ? <p>Este material ainda não tem habilidades associadas. Isso não impede seu uso em aula.</p> : <ul className="space-y-3">{result.data.associations.map(s => <li key={s.id} className="rounded-xl border border-slate-200 p-3 dark:border-white/10"><h3 className="font-bold">{s.code} · {s.gradeName}</h3><p className="mt-1 leading-6">{s.description}</p><p className="mt-1 font-semibold">{associationLabel[s.status]}</p>{s.status === 'confirmed' && <p className="mt-1 whitespace-pre-wrap break-words leading-6">{s.location} · {s.reason}</p>}{s.status === 'needs_review' && <p className="mt-1">Houve uma mudança desde a conferência anterior. Confira o conteúdo antes de usar.</p>}{s.status === 'legacy' && <p className="mt-1">Associação do cadastro anterior, sem nova conferência registrada.</p>}</li>)}</ul>}
    <p className="leading-6">Use estas informações como apoio. A associação não é uma aprovação do MEC nem garante que o material seja adequado à sua turma.</p>
  </>}</section>;
}
