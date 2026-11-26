export default function Spinner({ size = 'md', text }) {
  const sizeClass = size === 'sm' ? 'w-5 h-5' : size === 'lg' ? 'w-12 h-12' : 'w-8 h-8';
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 animate-fade-in">
      <div className={`${sizeClass} border-[3px] border-primary-100 border-t-primary-500 rounded-full animate-spin`} />
      {text && <p className="text-sm text-neutral-600 dark:text-neutral-300">{text}</p>}
    </div>
  );
}
