export function pluralize(count, singular, plural) {
  return Number(count) === 1 ? singular : plural;
}

export function formatCount(count, singular, plural) {
  const value = Number(count) || 0;
  return `${value} ${pluralize(value, singular, plural)}`;
}
