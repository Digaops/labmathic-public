import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import publicApi from '../services/publicApi';
import MaterialPreview from '../components/MaterialPreview';
import { externalMaterialUrl } from '../services/materialView.mjs';
import { validPublicToken, sharedMaterialId, parseSharedMaterial, sharedFileUrl, sharedUnavailable } from '../services/publicAccess.mjs';
import { materialButton as button, materialSurface as surface } from '../components/MaterialResourceState';
import { Download, ExternalLink } from 'lucide-react';

export default function SharedMaterial() {
  const { token } = useParams();
  return <SharedContent key={token} token={token} />;
}
function SharedContent({ token }) {
  const [resource, setResource] = useState({ state: validPublicToken(token) ? 'loading' : 'unavailable' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!validPublicToken(token)) return;
    const controller = new AbortController();
    setResource({ state: 'loading' });
    (async () => {
      try {
        const share = await publicApi.get('/share/' + token, { signal: controller.signal });
        const id = sharedMaterialId(share.data);
        const result = await publicApi.get('/materials/' + id + '/public', { params: { token }, signal: controller.signal });
        const data = parseSharedMaterial(result.data, id);
        if (!controller.signal.aborted) setResource({ state: 'ready', data });
      } catch (error) {
        if (!controller.signal.aborted) setResource({ state: sharedUnavailable(error) ? 'unavailable' : 'error' });
      }
    })();
    return () => controller.abort();
  }, [token, attempt]);
  const m = resource.data, file = m && sharedFileUrl(m.file_path, token);
  const external = m && externalMaterialUrl(m.external_url);
  return <div data-shared-access className="shared-access min-h-svh bg-slate-50 text-slate-900 dark:bg-[#061B3A] dark:text-slate-100">
    <header className="border-b border-slate-200 bg-white px-3 dark:border-white/10 dark:bg-[#111E31]">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-3 py-2">
        <span className="flex items-center gap-2 text-sm font-semibold"><img src="/logos/logo-labmathic-mark.png" alt="LabMathic" width="30" height="30" />Material compartilhado</span>
        <Link to="/login" className={button}>Entrar</Link>
      </div>
    </header>
    <main className="mx-auto max-w-5xl space-y-3 px-3 py-3">
      {resource.state !== 'ready' ? <section className={surface + ' p-5'}>
        <h1 className="text-xl font-bold">{resource.state === 'loading' ? 'Abrindo material' : resource.state === 'unavailable' ? 'Link indisponível' : 'Não foi possível carregar'}</h1>
        <p role={resource.state === 'loading' ? 'status' : 'alert'} className="mt-2 text-sm leading-6">{resource.state === 'loading' ? 'Aguarde enquanto conferimos o link.' : resource.state === 'unavailable' ? 'O link pode ter expirado ou sido desativado. Peça outro a quem enviou o material.' : 'O serviço pode estar indisponível no momento. Confira sua conexão ou tente novamente em instantes.'}</p>
        {resource.state === 'error' && <button type="button" className={button + ' mt-3'} onClick={() => setAttempt(v => v + 1)}>Tentar novamente</button>}
      </section> : <>
        <section className={surface + ' px-4 py-3'}>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{m.title}</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{[m.discipline_name, m.grade_name, m.material_type_name].filter(Boolean).join(' · ')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {file && <a href={file} download referrerPolicy="no-referrer" className={button}><Download size={17} aria-hidden="true" />Baixar material</a>}
            {external && <a href={external} target="_blank" rel="noopener noreferrer" className={button}><ExternalLink size={17} aria-hidden="true" />Abrir no site de origem</a>}
          </div>
        </section>
        <section aria-label="Leitura do material" className={surface + ' overflow-hidden'}>
          <MaterialPreview material={m} fileUrl={file} restrictFeatures shared onRetry={() => setAttempt(v => v + 1)} />
        </section>
        <details className={surface}><summary className="min-h-11 cursor-pointer rounded-xl px-4 py-3 text-sm font-semibold">Sobre este material</summary>
          <div className="border-t border-slate-200 p-4 dark:border-white/10"><p className="whitespace-pre-wrap text-sm leading-6">{m.description || 'Este material ainda não tem descrição.'}</p></div>
        </details>
        <p className="px-1 text-xs leading-5 text-slate-600 dark:text-slate-300">Acesso por link temporário. Se ele deixar de funcionar, peça um novo a quem compartilhou.</p>
      </>}
    </main>
  </div>;
}
