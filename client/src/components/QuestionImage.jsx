const VARIANTS = {
  thumbnail: {
    wrapper: 'mt-3 inline-flex max-w-full rounded-lg border border-neutral-100 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-900/30',
    image: 'block h-auto max-h-40 max-w-full rounded-md object-contain sm:max-h-44',
  },
  detail: {
    wrapper: 'mt-3 inline-flex max-w-full rounded-xl border border-neutral-100 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-900/30',
    image: 'block h-auto max-h-[320px] max-w-full rounded-lg object-contain sm:max-h-[380px]',
  },
  preview: {
    wrapper: 'inline-flex max-w-full rounded-xl border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-900/30',
    image: 'block h-auto max-h-64 max-w-full rounded-lg object-contain sm:max-h-72',
  },
};

export default function QuestionImage({
  src,
  alt,
  variant = 'thumbnail',
  className = '',
  imageClassName = '',
}) {
  if (!src) return null;

  const styles = VARIANTS[variant] || VARIANTS.thumbnail;

  return (
    <figure className={`${styles.wrapper} ${className}`.trim()}>
      <img
        src={src}
        alt={alt}
        className={`${styles.image} ${imageClassName}`.trim()}
        loading="lazy"
      />
    </figure>
  );
}
