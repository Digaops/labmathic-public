import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function NotFound() {
  const { user } = useAuth();
  const link = 'inline-flex min-h-11 items-center justify-center rounded-xl px-4 py-3 text-sm font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600';
  return <main data-not-found className="flex min-h-svh items-center justify-center bg-slate-50 px-3 py-5 text-slate-900 dark:bg-[#061B3A] dark:text-slate-100">
    <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-[#111E31]">
      <p className="mb-2 text-sm font-semibold text-slate-500 dark:text-slate-400">Erro 404</p>
      <h1 className="text-2xl font-bold">Página não encontrada</h1>
      <p className="mt-3 text-sm leading-6">O endereço pode ter mudado ou estar incompleto. Confira o link ou escolha um caminho abaixo.</p>
      <nav aria-label="Continuar na plataforma" className="mt-4 flex flex-wrap gap-2">
        <Link className={link + ' bg-blue-700 text-white hover:bg-blue-800'} to={user ? '/' : '/login'}>{user ? 'Ir para Início' : 'Entrar na plataforma'}</Link>
        {user && <Link className={link + ' border border-slate-300 text-blue-700 dark:border-white/20 dark:text-cyan-200'} to="/biblioteca">Abrir Biblioteca</Link>}
      </nav>
    </section>
  </main>;
}
