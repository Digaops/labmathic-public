import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import useHomeResource from '../../hooks/useHomeResource';
import ReportExport from '../../components/admin/ReportExport';
import { readPanel, readButton, readField, ReadState, ReadMetrics } from '../../components/admin/AdminReadParts';
import { reportViews, reportView, reportOverview, reportMaterials, reportPeople, reportBank, reportTimeline, bankGroups, shortDay } from '../../services/adminReportsView.mjs';

const sources = { overview: ['overview', reportOverview], materials: ['top-materials', reportMaterials], bank: ['question-bank-usage', reportBank], people: ['top-users', reportPeople], accesses: ['access-timeline', reportTimeline] };
export default function AdminReports() {
  const { user, announcementAccessId } = useAuth(), [params, setParams] = useSearchParams();
  const identity = user?.id + ':' + announcementAccessId, view = reportView(params.get('view'));
  return user?.role === 'admin' ? <ReportsWorkspace key={identity} identity={identity} view={view} onView={value => setParams({ view: value })} /> : null;
}
function ReportsWorkspace({ identity, view, onView }) {
  const [exporting, setExporting] = useState(false), title = useRef(null);
  return <div data-admin-read style={{ maxWidth: '64rem' }} className="mx-auto space-y-3 rounded-2xl bg-slate-50 px-3 py-4 text-slate-900 sm:px-6 dark:bg-transparent dark:text-slate-100">
    <header className="flex items-center justify-between gap-2"><h1 ref={title} tabIndex={-1} className="text-xl font-bold sm:text-2xl">Relatórios de uso</h1><button type="button" className={readButton + ' shrink-0'} onClick={() => setExporting(true)}>Baixar CSV</button></header>
    <p className="text-sm leading-6">Consulte os registros de uso da plataforma.</p>
    <ReportData identity={identity} view={view} onView={onView} />
    {exporting && <ReportExport onClose={() => { setExporting(false); requestAnimationFrame(() => title.current?.focus({ preventScroll: true })); }} />}
  </div>;
}
function ReportData({ identity, view, onView }) {
  const [url, parse] = sources[view], resource = useHomeResource('/reports/' + url, identity, parse);
  return <section className="space-y-3" aria-label={reportViews[view]}>
    <h2 className="sr-only">{reportViews[view]}</h2><div className="flex items-center gap-2"><label htmlFor="report-view" className="sr-only">Escolher relatório</label><select id="report-view" className={readField} value={view} onChange={e => onView(e.target.value)}>{Object.entries(reportViews).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button type="button" className={readButton + ' shrink-0 whitespace-nowrap'} disabled={resource.status === 'loading'} onClick={resource.retry}>Atualizar</button></div>
    <ReadState resource={resource}>{data => view === 'overview' ? <Overview data={data} /> : view === 'materials' ? <Materials data={data} /> : view === 'bank' ? <Bank data={data} /> : view === 'people' ? <People data={data} /> : <Timeline data={data} />}</ReadState>
  </section>;
}
function Overview({ data }) {
  return <div className={readPanel + ' space-y-4 p-3'}>
    <p className="text-xs leading-5 text-slate-600 dark:text-slate-300">Totais acumulados dos registros disponíveis. Não são pessoas únicas por acesso.</p>
    <ReadMetrics rows={[[ 'Materiais cadastrados', data.totalMaterials ], ['Contas cadastradas', data.totalUsers], ['Entradas no sistema', data.totalSystemAccesses], ['Acessos a materiais', data.totalMaterialAccesses], ['Acessos a simulados', data.totalQuestionSetAccesses], ['Downloads registrados', data.totalDownloads]]} />
    <details><summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-blue-700 dark:text-cyan-200">Outros indicadores</summary><ReadMetrics rows={[[ 'Acessos a conteúdos (materiais + simulados)', data.totalContentAccesses ], ['Favoritos salvos', data.totalFavorites], ['Comentários', data.totalComments], ['Nota média dos materiais', data.avgRating ? data.avgRating.toLocaleString('pt-BR') + ' de 5' : 'Sem avaliações'], ['Conversas com a administração', data.totalSupportThreads], ['Mensagens docentes não lidas', data.unreadSupportMessages]]} /></details>
  </div>;
}
function Materials({ data }) {
  const max = Math.max(...data.map(i => i.access_count), 1);
  return <><p className="text-xs leading-5 text-slate-600 dark:text-slate-300">Até 10 materiais, ordenados por acessos acumulados. Acessos repetidos também contam.</p>{!data.length ? <Empty /> : <ol aria-label="Materiais por acessos" className={readPanel + ' divide-y divide-slate-200 dark:divide-white/10'}>{data.map((item, n) => <li key={item.id} className="space-y-2 p-3">
    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="text-sm font-bold leading-6">{n + 1}. {item.title}</h3><p className="text-xs text-slate-600 dark:text-slate-300">{item.discipline_name || 'Sem disciplina informada'}</p></div><p className="shrink-0 text-right text-sm font-bold">{item.access_count.toLocaleString('pt-BR')}<span className="block text-xs font-normal">acessos</span></p></div>
    <div aria-hidden="true" className="h-1.5 rounded bg-slate-100 dark:bg-white/10"><div className="h-full rounded bg-blue-600 dark:bg-cyan-400" style={{ width: `${item.access_count / max * 100}%` }} /></div>
  </li>)}</ol>}</>;
}
function Bank({ data }) {
  return <><p className="text-xs leading-5 text-slate-600 dark:text-slate-300">Cadastros acumulados. “Revisada” indica uma revisão registrada, não uma medida de aprendizagem.</p>
    <div className="grid gap-3 sm:grid-cols-2">{bankGroups.map(([label, fields], index) => <details key={label} open={index === 0} className={readPanel + ' px-3 pb-3'}><summary className="min-h-11 cursor-pointer py-3 text-sm font-bold">{label}</summary><ReadMetrics rows={fields.map(([key, text]) => [text, data.totals[key]])} /></details>)}</div>
    <Authors data={data.authorEngagement} />
  </>;
}
function Authors({ data }) {
  const [limit, setLimit] = useState(20);
  return <details className={readPanel + ' p-3'}><summary className="min-h-11 cursor-pointer py-3 text-sm font-bold">Criação por professor ({data.length})</summary><p className="mb-3 text-xs leading-5">Registros de autoria, não avaliação do trabalho docente.</p>{!data.length ? <Empty /> : <ul aria-label="Autores" className="divide-y divide-slate-200 dark:divide-white/10">{data.slice(0, limit).map(item => <li key={item.user_id} className="space-y-2 py-3"><h3 className="text-sm font-bold">{item.user_name}</h3><p className="text-xs text-slate-600 dark:text-slate-300">{item.email}</p><ReadMetrics rows={[[ 'Questões próprias', item.author_question_count ], ['Simulados com questões próprias', item.author_set_count], ['Acessos a esses simulados', item.author_set_access_count]]} /></li>)}</ul>}{data.length > limit && <button type="button" className={readButton} onClick={() => setLimit(n => n + 20)}>Mostrar mais autores</button>}</details>;
}
function People({ data }) {
  return <><p className="text-xs leading-5 text-slate-600 dark:text-slate-300">Até 10 contas, ordenadas por entradas no sistema e acessos a conteúdos. Estes números não avaliam o trabalho docente.</p>{!data.length ? <Empty /> : <ul aria-label="Uso por pessoa" className={readPanel + ' divide-y divide-slate-200 dark:divide-white/10'}>{data.map(item => <li key={item.id} className="p-3"><h3 className="text-sm font-bold leading-6">{item.name}</h3><p className="mb-2 text-xs text-slate-600 dark:text-slate-300">{item.email}</p><ReadMetrics rows={[[ 'Entradas', item.system_access_count ], ['Materiais abertos', item.material_access_count], ['Simulados abertos', item.question_set_access_count]]} /><details><summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-blue-700 dark:text-cyan-200">Outras interações</summary><ReadMetrics rows={[[ 'Favoritos', item.favorites_count ], ['Comentários', item.comments_count]]} /></details></li>)}</ul>}</>;
}
function Timeline({ data }) {
  const [all, setAll] = useState(false), max = Math.max(...data.map(i => i.count), 1), total = data.reduce((sum, i) => sum + i.count, 0);
  return <div className={readPanel + ' space-y-3 p-3'}><p className="text-sm"><strong>{total.toLocaleString('pt-BR')}</strong> entradas registradas nos últimos 30 dias.</p><p className="text-xs leading-5 text-slate-600 dark:text-slate-300">Uma pessoa pode entrar várias vezes. Os dias seguem o horário do servidor.</p>
    {!data.length ? <Empty /> : <ol aria-label="Entradas por dia" className="space-y-2">{[...data].reverse().slice(0, all ? data.length : 7).map(day => <li key={day.date} className="grid grid-cols-[6rem_1fr_3rem] items-center gap-2 text-sm"><time dateTime={day.date}>{shortDay(day.date)}</time><div aria-hidden="true" className="h-2 rounded bg-slate-100 dark:bg-white/10"><div className="h-full rounded bg-blue-600 dark:bg-cyan-400" style={{ width: `${day.count / max * 100}%` }} /></div><span className="text-right font-semibold">{day.count.toLocaleString('pt-BR')}<span className="sr-only"> entradas</span></span></li>)}</ol>}
    {data.length > 7 && <button type="button" className={readButton} aria-expanded={all} onClick={() => setAll(s => !s)}>{all ? 'Mostrar só 7 dias' : 'Ver os 30 dias'}</button>}
  </div>;
}
function Empty() { return <p className="py-3 text-sm leading-6">Nenhum registro nesta consulta.</p>; }
