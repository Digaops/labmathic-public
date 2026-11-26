export default function AdminPageHeader({ icon: Icon, title, description, action, className = '' }) {
  return (
    <div className={`mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between ${className}`}>
      <div className="flex min-w-0 gap-3">
        {Icon ? (
          <div className="mt-0.5 flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl border border-primary-200/80 bg-white text-primary-600 shadow-sm dark:border-white/10 dark:bg-white/10 dark:text-cyan-300">
            <Icon size={21} />
          </div>
        ) : null}
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white sm:text-3xl">
            {title}
          </h1>
          {description ? (
            <p className="mt-1.5 max-w-3xl text-sm font-medium leading-relaxed text-slate-600 dark:text-slate-300">
              {description}
            </p>
          ) : null}
        </div>
      </div>

      {action ? (
        <div className="flex flex-shrink-0 sm:pt-1">
          {action}
        </div>
      ) : null}
    </div>
  );
}
