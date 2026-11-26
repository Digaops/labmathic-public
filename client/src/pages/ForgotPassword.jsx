import { useState } from 'react';
import PublicAccess, { PublicNotice, accessButton, accessInput, accessLink } from '../components/PublicAccess';
import usePublicWrite from '../hooks/usePublicWrite';
import publicApi from '../services/publicApi';
import { confirmPublicMessage, publicWriteUncertain, publicError } from '../services/publicAccess.mjs';

export default function ForgotPassword() {
  const [email, setEmail] = useState(''), [sent, setSent] = useState(false), [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const write = usePublicWrite();
  function submit(event) {
    event.preventDefault();
    if (uncertain) return;
    setError('');
    const submitted = email.trim();
    write.run(async signal => {
      const { data } = await publicApi.post('/auth/forgot-password', { email: submitted }, { signal, timeout: 30000 });
      confirmPublicMessage(data);
    }, () => { setEmail(submitted); setSent(true); }, error => {
      if (publicWriteUncertain(error)) { setUncertain(true); setError('Não recebemos a confirmação do pedido. Confira seu e-mail e a pasta de spam antes de pedir outro link.'); }
      else setError(publicError(error, 'Não foi possível solicitar o link. Tente novamente.'));
    });
  }
  return <PublicAccess title={sent ? 'Confira seu e-mail' : 'Recuperar senha'} description={sent ? null : 'Informe o e-mail cadastrado na sua conta. Ele pode ser pessoal ou da escola.'}>
    {sent ? <div>
      <PublicNotice success text="Se esse e-mail estiver cadastrado, você receberá um link para criar outra senha." />
      <p className="break-words text-sm text-[#0F172A]">{email}</p>
      <p className="mt-3 text-sm leading-6 text-[#64748B]">Confira também a pasta de spam. O link vale por uma hora e só pode ser usado uma vez.</p>
      <button type="button" className={accessLink} onClick={() => { setSent(false); setError(''); }}>Corrigir e-mail</button>
    </div> : <>
      <PublicNotice text={error} />
      <form className="mt-4 space-y-4" onSubmit={submit} aria-busy={write.busy}>
        <div><label htmlFor="recovery-email" className="mb-1 block text-sm font-semibold text-[#0F172A]">E-mail cadastrado</label>
          <input id="recovery-email" name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} disabled={write.busy || uncertain} className={accessInput} /></div>
        {!uncertain && <button type="submit" disabled={write.busy} className={accessButton + ' w-full'}>{write.busy ? 'Solicitando…' : 'Enviar link de recuperação'}</button>}
      </form>
      {uncertain && <button type="button" className={accessLink + ' mt-3'} onClick={() => { setUncertain(false); setError(''); }}>Conferi meu e-mail; tentar novamente</button>}
    </>}
  </PublicAccess>;
}
