export function parseStudentFeedback(value) {
  if (!value || typeof value.message !== 'string' || value.message.trim().length < 10
    || value.message.length > 2000 || typeof value.releasedAt !== 'string'
    || !Number.isFinite(Date.parse(value.releasedAt))) throw new Error('Devolutiva não confirmada.');
  return value;
}

// A resposta pode se perder depois de o servidor salvar. Conferir antes de orientar um novo envio.
export async function sendStudentFeedback(api, path, operation) {
  try {
    const response = await api.post(`${path}/feedback`, operation.body, {
      headers: { 'Idempotency-Key': operation.key }, timeout: 15000,
    });
    return parseStudentFeedback(response.data.feedback);
  } catch (error) {
    try {
      const current = await api.get(path, { timeout: 15000 });
      if (current.data.feedback) return parseStudentFeedback(current.data.feedback);
    } catch { /* A operação mantém sua chave para uma nova tentativa segura. */ }
    throw error;
  }
}
