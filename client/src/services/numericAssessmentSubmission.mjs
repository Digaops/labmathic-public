// Keep a lost response tied to its original content and idempotency key.
// This lives only in memory; participant IDs are never persisted in browser storage.
export function createNumericSubmission() {
  let request = null;
  let uncertain = false;
  return {
    get uncertain() { return uncertain; },
    get request() { return request; },
    begin(body, key) {
      if (!request) {
        const copy = structuredClone(body);
        Object.freeze(copy.numericVersionIds);
        Object.freeze(copy.participantIds);
        request = Object.freeze({ body: Object.freeze(copy), key });
      }
      return request;
    },
    failed(error) {
      const status = error?.response?.status;
      // A later rejection cannot prove that an earlier, uncertain write failed.
      uncertain = uncertain || !Number.isInteger(status) || status < 400 || status >= 500 || status === 408;
      if (!uncertain) request = null;
      return uncertain;
    },
    confirmed() { request = null; uncertain = false; },
  };
}

export const numericSubmissionLeaveMessage = 'O primeiro envio pode ter sido salvo. Sair e conferir a lista antes de criar outra aplicação?';
