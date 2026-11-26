import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import publicApi from '../services/publicApi';
import usePublicWrite from '../hooks/usePublicWrite';
import { PublicNotice, accessButton, accessInput, accessLink } from '../components/PublicAccess';
import { publicError, publicWriteUncertain } from '../services/publicAccess.mjs';
import { formatClassCode, normalizedClassCode, joinProblem, parseClassJoin } from '../services/auxiliaryView.mjs';

function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(24); globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
export default function JoinClass() {
  const [params] = useSearchParams();
  const code = normalizedClassCode(params.get('codigo'));
  return <JoinForm key={code} initialCode={code} />;
}
function JoinForm({ initialCode }) {
  const [form, setForm] = useState({ code: formatClassCode(initialCode), displayName: '' });
  const [id] = useState(requestId), [result, setResult] = useState(null), [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false); const frozen = useRef(null);
  const write = usePublicWrite();
  function send(event) {
    event.preventDefault();
    const problem = joinProblem(form); setError(problem); if (problem) return;
    if (!frozen.current) frozen.current = { code: normalizedClassCode(form.code), displayName: form.displayName.trim(), requestId: id };
    write.run(async signal => {
      const { data } = await publicApi.post('/classes/join', frozen.current, { signal, timeout: 30000 });
      return parseClassJoin(data);
    }, data => { setResult(data); setError(''); }, err => {
      if (uncertain || publicWriteUncertain(err)) {
        setUncertain(true); setError('Não conseguimos confirmar a entrada. Mantenha esta página aberta e confira o mesmo pedido abaixo. Se não conseguir, peça ao professor para verificar a lista da turma.');
      } else { frozen.current = null; setError(publicError(err, 'Confira os dados ou peça outro código ao professor.')); }
    });
  }
  return <main data-join-class className="login-screen public-access min-h-svh bg-[#061B3A] px-3 py-4 text-[#0F172A]">
    <section className="mx-auto max-w-lg rounded-2xl bg-white p-5 shadow-xl sm:p-7">
      <div className="mb-3 flex items-center gap-2"><img src="/logos/logo-labmathic-mark.png" alt="" width="32" height="32" /><span className="text-lg font-extrabold text-[#0F172A]">LabMathic</span></div>
      <h1 className="text-2xl font-extrabold text-[#0F172A]">{result ? 'Entrada confirmada' : 'Entrar em uma turma'}</h1>
      {result ? <>
        <PublicNotice success text={result.message} />
        <dl className="space-y-3 text-sm text-[#0F172A]"><div><dt className="text-[#64748B]">Turma</dt><dd className="font-bold">{result.className}</dd></div><div><dt className="text-[#64748B]">Professor(a)</dt><dd className="font-bold">{result.teacherName}</dd></div></dl>
        <p className="mt-4 text-sm leading-6 text-[#64748B]">Você pode fechar esta página. Seu nome já está na lista do professor.</p>
      </> : <>
        {!uncertain && <p className="mt-2 text-sm leading-6 text-[#64748B]">Use o código do professor e seu nome usado na chamada.</p>}
        <PublicNotice text={error} />
        <form onSubmit={send} className="mt-4 space-y-3" aria-busy={write.busy}>
          <div><label htmlFor="class-code" className="mb-1 block text-sm font-semibold text-[#0F172A]">Código da turma</label><input id="class-code" className={accessInput + ' font-mono'} required maxLength={64} autoComplete="off" autoCapitalize="characters" spellCheck={false} value={form.code} disabled={write.busy || uncertain} onChange={e => setForm(f => ({ ...f, code: formatClassCode(e.target.value) }))} placeholder="ABCD-EFGH-JKLM-NPQR" /></div>
          <div><label htmlFor="student-name" className="mb-1 block text-sm font-semibold text-[#0F172A]">Seu nome na escola</label><input id="student-name" className={accessInput} required maxLength={120} autoComplete="off" value={form.displayName} disabled={write.busy || uncertain} onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))} /></div>
          {!uncertain && <p className="text-xs leading-5 text-[#64748B]">Não informe CPF, endereço, telefone, senha ou e-mail pessoal. Este cadastro é apenas para organizar a turma.</p>}
          <button type="submit" className={accessButton + ' w-full'} disabled={write.busy}>{write.busy ? 'Conferindo…' : uncertain ? 'Conferir ou concluir esta entrada' : 'Confirmar entrada'}</button>
          {uncertain && <p className="text-xs leading-5 text-[#64748B]">Vamos usar o mesmo pedido, sem criar outra matrícula por esta tentativa. Não abra um novo cadastro enquanto aguarda.</p>}
        </form>
      </>}
      <p className="mt-3 text-xs leading-5 text-[#64748B]">Recebeu um código para responder uma avaliação?</p>
      <Link to="/responder" className={accessLink}>Ir para a avaliação</Link>
    </section>
  </main>;
}
