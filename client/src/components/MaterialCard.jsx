import { Link, useLocation } from 'react-router-dom';
import { Video, Image, FileText, File, Presentation, Clock, FileStack, ArrowRight, Eye, Star } from 'lucide-react';

const typeConfig = {
  video:        { icon: Video,        bg: 'bg-red-500',    light: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300' },
  image:        { icon: Image,        bg: 'bg-purple-500', light: 'bg-purple-50 text-purple-600 dark:bg-purple-500/10 dark:text-purple-300' },
  pdf:          { icon: FileText,     bg: 'bg-orange-500', light: 'bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-300' },
  document:     { icon: File,         bg: 'bg-blue-500',   light: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300' },
  presentation: { icon: Presentation, bg: 'bg-amber-500',  light: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300' },
};

export default function MaterialCard({ material, compactOnMobile = false, fromLabel = 'Laboratórios' }) {
  const config = typeConfig[material.material_type_icon] || { icon: File, bg: 'bg-neutral-500', light: 'bg-neutral-100 text-neutral-600 dark:bg-white/10 dark:text-slate-300' };
  const Icon = config.icon;
  const location = useLocation();
  const topics = material.topics?.slice(0, 2) || [];
  const hasPrimaryMeta = material.discipline_name || material.grade_name || topics.length > 0;

  return (
      <Link
        to={`/material/${material.id}`}
        className="card-hover group flex h-full flex-col overflow-hidden border-neutral-200/80 bg-white/95 shadow-sm shadow-slate-900/5 dark:border-white/10 dark:bg-[#111E31] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600 dark:focus-visible:outline-cyan-300"
        state={{
          from: `${location.pathname}${location.search}`,
          fromLabel,
        }}
      >
      {/* Type accent bar */}
      <div className={`h-1 ${config.bg}`} />

      <div className={`flex flex-1 flex-col ${compactOnMobile ? 'p-3 sm:p-4' : 'p-4'}`}>
        {/* Type badge */}
        <div className={`${compactOnMobile ? 'mb-2 sm:mb-3' : 'mb-3'} flex min-w-0 items-start justify-between gap-2`}>
          <span className={`inline-flex min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${config.light}`}>
            <Icon size={13} />
            <span className="truncate">{material.material_type_name || 'Material'}</span>
          </span>
          {material.file_format && (
            <span className="flex-shrink-0 rounded-md bg-neutral-100 px-2 py-0.5 text-[10px] font-bold uppercase text-neutral-500 dark:bg-white/10 dark:text-slate-300">
              {material.file_format}
            </span>
          )}
        </div>

        {/* Title */}
        <h3 className={`${compactOnMobile ? 'sm:line-clamp-2' : 'line-clamp-2'} mb-2 break-words text-[15px] font-bold leading-snug text-neutral-800 transition-colors group-hover:text-primary-600 dark:text-slate-100 dark:group-hover:text-cyan-300`}>
          {material.title}
        </h3>
        <p className={`${compactOnMobile ? 'hidden sm:line-clamp-2' : 'line-clamp-2'} mb-3 flex-1 break-words text-sm leading-relaxed text-neutral-500 dark:text-slate-300`}>
          {material.description || 'Descrição não informada.'}
        </p>

        {/* Pedagogical context */}
        {hasPrimaryMeta && (
          <div className={`${compactOnMobile ? 'mb-2 sm:mb-3' : 'mb-3'} flex flex-wrap gap-1.5`}>
            {material.discipline_name && (
              <span className="rounded-lg bg-primary-50/80 px-2 py-0.5 text-xs font-semibold text-primary-700 ring-1 ring-primary-100 dark:bg-primary-500/10 dark:text-primary-200 dark:ring-primary-400/20">
                {material.discipline_name}
              </span>
            )}
            {material.grade_name && (
              <span className="rounded-lg bg-secondary-50/80 px-2 py-0.5 text-xs font-semibold text-secondary-700 ring-1 ring-secondary-100 dark:bg-secondary-500/10 dark:text-secondary-200 dark:ring-secondary-400/20">
                {material.grade_name}
              </span>
            )}
            {topics.map(t => (
              <span key={t.id} className={`${compactOnMobile ? 'hidden sm:inline' : ''} max-w-full truncate rounded-lg bg-neutral-100/80 px-2 py-0.5 text-xs font-semibold text-neutral-600 ring-1 ring-neutral-200/60 dark:bg-white/5 dark:text-slate-300 dark:ring-white/10`}>
                {t.name}
              </span>
            ))}
          </div>
        )}

        {/* Meta */}
        <div className={`${compactOnMobile ? 'hidden sm:flex' : 'flex'} mb-4 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-400 dark:text-slate-400`}>
          {material.view_count > 0 && (
            <span className="flex items-center gap-1">
              <Eye size={12} />
              {material.view_count}
            </span>
          )}
          {material.avg_rating > 0 && (
            <span className="flex items-center gap-1">
              <Star size={12} className="text-amber-400 fill-amber-400" />
              {material.avg_rating}
            </span>
          )}
          {material.duration && (
            <span className="flex items-center gap-1">
              <Clock size={12} />
              {material.duration}
            </span>
          )}
          {material.page_count && (
            <span className="flex items-center gap-1">
              <FileStack size={12} />
              {material.page_count} págs
            </span>
          )}
        </div>

        {/* CTA */}
        <div className={`${compactOnMobile ? 'pt-2 sm:pt-3' : 'pt-3'} mt-auto flex items-center justify-between border-t border-neutral-100 dark:border-white/10`}>
          <span className="inline-flex items-center gap-1.5 text-sm font-bold text-primary-600 transition-colors group-hover:text-primary-700 dark:text-cyan-300 dark:group-hover:text-cyan-200">
            Abrir material
            <ArrowRight size={14} className="motion-safe:group-hover:translate-x-0.5 transition-transform" />
          </span>
        </div>
      </div>
    </Link>
  );
}
