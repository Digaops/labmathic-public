import { useEffect, useRef } from 'react';

export default function AuthoringWriteAlert({ message, uncertain = false, href, onAcknowledge }) {
  const ref = useRef(null);
  const alertMessage = message || (uncertain ? 'Ainda não foi possível confirmar o resultado do envio.' : '');
  useEffect(() => {
    if (alertMessage) { ref.current?.focus({ preventScroll: true }); ref.current?.scrollIntoView({ block: 'nearest' }); }
  }, [alertMessage, uncertain]);
  if (!alertMessage) return null;
  return <div ref={ref} role="alert" tabIndex={-1} className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 outline-none dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100">
    <p>{alertMessage}</p>
    {uncertain && <div className="mt-2 space-y-2">
      <p>O pedido pode ter sido salvo. Confira em outra aba antes de tentar novamente. Repetir a criação pode gerar uma cópia.</p>
      <a className="btn-outline" href={href} target="_blank" rel="noopener noreferrer">Conferir em outra aba</a>
      <button type="button" className="btn-outline" onClick={() => {
        if (window.confirm('Você conferiu o resultado da tentativa anterior? Repetir uma criação já salva pode gerar uma cópia.')) onAcknowledge();
      }}>Já conferi: liberar nova tentativa</button>
    </div>}
  </div>;
}
