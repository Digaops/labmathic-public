import { useState } from 'react';
import { Star, MessageCircle, ChevronDown, Send, Pencil, Trash2, Check } from 'lucide-react';
import api from '../services/api';
import useReadOnlyResource from '../hooks/useHomeResource';
import { parseRating, parseComments, materialDate } from '../services/materialView.mjs';
import { formatCount } from '../utils/pluralize';
import MaterialResourceState, { materialButton as button, materialSurface as surface, materialFocus as focus } from './MaterialResourceState';

export default function MaterialFeedback({ id, identity, user, action }) {
  const [open, setOpen] = useState(false);
  const rating = useReadOnlyResource(open ? `/ratings/material/${id}` : null, identity, parseRating);
  const comments = useReadOnlyResource(open ? `/comments/material/${id}` : null, identity, parseComments);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(null);
  const [editText, setEditText] = useState('');
  const [removing, setRemoving] = useState(null);
  const [hover, setHover] = useState(0);
  const valid = value => value.trim().length >= 2 && value.trim().length <= 1000;

  function commentWrite(method, url, body, message, onSuccess) {
    action.run(async () => {
      const response = await api[method](url, body, { timeout: 15000 });
      parseComments([response.data]);
    }, { refresh: comments.retry, message, onSuccess });
  }
  return <details className={surface} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={`flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-2xl px-4 py-3 font-semibold text-slate-900 dark:text-white [&::-webkit-details-marker]:hidden ${focus}`}>
      <MessageCircle size={18} aria-hidden="true" /><span className="flex-1">Avaliar e comentar</span><ChevronDown size={18} aria-hidden="true" />
    </summary>
    <div className="space-y-5 border-t border-slate-200 p-4 dark:border-white/10">
      <section aria-label="Avaliação do material">
        <h2 className="font-bold text-slate-900 dark:text-white">Este material ajudou na sua aula?</h2>
        <MaterialResourceState resource={rating} label="as avaliações" />
        {rating.status === 'ready' && <>
          <div className="mt-2 flex flex-wrap gap-1">{[1, 2, 3, 4, 5].map(score => <button key={score} type="button" className={`${button} w-11 px-0 text-amber-700 dark:text-amber-300`}
            aria-label={`Avaliar com ${score} ${score === 1 ? 'estrela' : 'estrelas'}`} aria-pressed={rating.data.userScore === score} disabled={action.busy}
            onMouseEnter={() => setHover(score)} onMouseLeave={() => setHover(0)}
            onClick={() => action.run(async () => { const response = await api.post('/ratings', { material_id: id, score }, { timeout: 15000 }); parseRating(response.data); }, { refresh: rating.retry, message: 'Avaliação salva.' })}>
            <Star size={22} aria-hidden="true" className={(hover || rating.data.userScore || 0) >= score ? 'fill-current' : ''} />
          </button>)}</div>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{rating.data.count ? `${rating.data.average} estrelas · ${formatCount(rating.data.count, 'avaliação', 'avaliações')}` : 'Ainda não há avaliações.'}</p>
        </>}
      </section>
      <section aria-label="Comentários">
        <h2 className="font-bold text-slate-900 dark:text-white">Comentários</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">Conte como usou o material. Outros usuários podem ler; evite dados de estudantes.</p>
        <MaterialResourceState resource={comments} label="os comentários" />
        {comments.status === 'ready' && <>
          <form className="my-3" onSubmit={event => { event.preventDefault(); if (valid(text)) commentWrite('post', '/comments', { material_id: id, text }, 'Comentário publicado.', () => setText('')); }}>
            <label htmlFor="material-comment" className="mb-1 block text-sm font-semibold text-slate-800 dark:text-slate-100">Seu comentário</label>
            <textarea id="material-comment" className={`input min-h-24 ${focus}`} value={text} onChange={event => setText(event.target.value)} maxLength={1000} disabled={action.busy} />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-slate-600 dark:text-slate-300">De 2 a 1.000 caracteres.</span><button type="submit" className={button} disabled={action.busy || !valid(text)}><Send size={16} aria-hidden="true" />Publicar comentário</button></div>
          </form>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">{formatCount(comments.data.length, 'comentário', 'comentários')}</p>
          {!comments.data.length && <p className="text-sm text-slate-600 dark:text-slate-300">Nenhum comentário publicado.</p>}
          <ul className="space-y-3">{comments.data.map(comment => <li key={comment.id} className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
            <div className="flex flex-wrap items-center gap-x-2 text-sm"><span className="break-words font-bold text-slate-900 dark:text-white">{comment.user_name}</span><span className="text-slate-600 dark:text-slate-300">{materialDate(comment.created_at)}</span></div>
            {editing === comment.id ? <form className="mt-2" onSubmit={event => { event.preventDefault(); if (valid(editText)) commentWrite('put', `/comments/${comment.id}`, { text: editText }, 'Comentário atualizado.', () => setEditing(null)); }}>
              <label htmlFor={`edit-comment-${comment.id}`} className="mb-1 block text-sm font-semibold">Editar seu comentário</label>
              <textarea id={`edit-comment-${comment.id}`} className={`input min-h-24 ${focus}`} value={editText} onChange={event => setEditText(event.target.value)} maxLength={1000} disabled={action.busy} />
              <div className="mt-2 flex flex-wrap gap-2"><button type="submit" className={button} disabled={action.busy || !valid(editText)}><Check size={16} aria-hidden="true" />Salvar comentário</button><button type="button" className={button} disabled={action.busy} onClick={() => setEditing(null)}>Cancelar edição</button></div>
            </form> : <p className="mt-1 whitespace-pre-line break-words text-sm leading-6 text-slate-700 dark:text-slate-200">{comment.text}</p>}
            {(comment.user_id === user.id || user.role === 'admin') && editing !== comment.id && (removing === comment.id ? <div className="mt-2">
              <p className="text-sm text-slate-700 dark:text-slate-200">Excluir este comentário? Não será possível recuperá-lo.</p>
              <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={action.busy} onClick={() => action.run(() => api.delete(`/comments/${comment.id}`, { timeout: 15000 }), { refresh: comments.retry, message: 'Comentário excluído.', onSuccess: () => setRemoving(null) })}>Confirmar exclusão</button><button type="button" className={button} disabled={action.busy} onClick={() => setRemoving(null)}>Manter comentário</button></div>
            </div> : <div className="mt-1 flex flex-wrap gap-2">
              {comment.user_id === user.id && <button type="button" className={button} disabled={action.busy} onClick={() => { setEditing(comment.id); setEditText(comment.text); }}><Pencil size={15} aria-hidden="true" />Editar comentário</button>}
              <button type="button" className={button} disabled={action.busy} onClick={() => setRemoving(comment.id)}><Trash2 size={15} aria-hidden="true" />Excluir comentário</button>
            </div>)}
          </li>)}</ul>
        </>}
      </section>
    </div>
  </details>;
}
