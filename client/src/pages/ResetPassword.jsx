import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import PublicAccess, { PublicNotice, PublicPassword, accessButton, accessLink } from '../components/PublicAccess';
import usePublicWrite from '../hooks/usePublicWrite';
import publicApi from '../services/publicApi';
import { validPublicToken, confirmPublicMessage, publicWriteUncertain, publicError, passwordProblem } from '../services/publicAccess.mjs';

export default function ResetPassword() {
  const { token } = useParams();
  return <ResetForm key={token} token={token} />;
}
function ResetForm({ token }) {
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [visible, setVisible] = useState(false), [error, setError] = useState('');
  const [state, setState] = useState(validPublicToken(token) ? 'ready' : 'unavailable');
  const write = usePublicWrite();
  function clear() { setPassword(''); setConfirmation(''); setVisible(false); }
  function submit(event) {
    event.preventDefault();
    if (state !== 'ready') return;
    const problem = passwordProblem(password, confirmation);
    setError(problem); if (problem) return;
    write.run(async signal => {
      const { data } = await publicApi.post('/auth/reset-password', { token, password }, { signal, timeout: 30000 });
      confirmPublicMessage(data);
    }, () => { clear(); setState('done'); }, err => {
      if (publicWriteUncertain(err)) { clear(); setState('uncertain'); }
      else if ([400, 409, 410].includes(err.response?.status)) { clear(); setState('unavailable'); }
      else setError(publicError(err, 'Não foi possível alterar a senha. Tente novamente.'));
    });
  }
  const title = { ready: 'Criar nova senha', done: 'Senha alterada', unavailable: 'Link indisponível', uncertain: 'Precisamos conferir a alteração' }[state];
  return <PublicAccess title={title} description={state === 'ready' ? 'Use pelo menos 8 caracteres. Você usará essa senha na próxima entrada.' : null}>
    {state === 'ready' ? <>
      <PublicNotice text={error} />
      <form onSubmit={submit} className="mt-4 space-y-4" aria-busy={write.busy}>
        <PublicPassword id="new-password" label="Nova senha" value={password} onChange={e => setPassword(e.target.value)} visible={visible} toggle={() => setVisible(v => !v)} disabled={write.busy} />
        <PublicPassword id="confirm-password" label="Confirmar nova senha" value={confirmation} onChange={e => setConfirmation(e.target.value)} visible={visible} toggle={() => setVisible(v => !v)} disabled={write.busy} />
        <button type="submit" disabled={write.busy} className={accessButton + ' w-full'}>{write.busy ? 'Salvando…' : 'Salvar nova senha'}</button>
      </form>
    </> : state === 'done' ? <PublicNotice success text="Sua nova senha foi salva. Volte para entrar na sua conta." />
      : state === 'uncertain' ? <><PublicNotice text="A resposta não chegou. A senha pode ter sido alterada. Tente entrar com a nova senha; se não conseguir, peça outro link. Este pedido não será reenviado automaticamente." /><Link to="/esqueci-senha" className={accessLink}>Pedir outro link</Link></>
      : <><PublicNotice text="Este link não pode ser usado. Ele pode ter expirado ou já ter sido utilizado. Peça outro link para continuar." /><Link to="/esqueci-senha" className={accessButton + ' w-full'}>Pedir outro link</Link></>}
  </PublicAccess>;
}
