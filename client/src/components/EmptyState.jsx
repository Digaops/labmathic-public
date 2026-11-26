export default function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
      {Icon && (
        <div className="w-20 h-20 bg-neutral-100 dark:bg-neutral-800 rounded-2xl flex items-center justify-center mb-5 shadow-sm">
          <Icon size={32} className="text-neutral-400" />
        </div>
      )}
      <h3 className="text-lg font-semibold text-neutral-600 dark:text-neutral-300 mb-1.5">{title}</h3>
      {description && <p className="text-sm text-neutral-400 max-w-md leading-relaxed">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
