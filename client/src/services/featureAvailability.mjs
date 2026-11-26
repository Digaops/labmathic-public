// Disponibilidade visual em memória; nunca substitui a autorização da API.
export function featureFailure(previous, status) {
  const denied = status === 401 || status === 403;
  return { features: denied ? {} : previous.features, loading: false,
    status: denied ? 'denied' : 'unavailable' };
}

export function validatedFeatures(payload, keys) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || keys.some(key => typeof payload[key] !== 'boolean')) {
    throw new Error('Disponibilidade incompleta. Tente novamente.');
  }
  return Object.fromEntries(keys.map(key => [key, payload[key]]));
}
