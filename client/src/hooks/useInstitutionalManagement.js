import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../services/api';
import useAccountLeave from './useAccountLeave';
import { managementState, prepareInstitutionalWrite, institutionalWriteResult, institutionalReceipt, institutionalError } from '../services/institutionalWrites.mjs';

const presentation = (current, stage, message = '') => ({ kind: current.kind, summary: current.summary, uncertain: current.uncertain, stage, message });

export default function useInstitutionalManagement(user, onChanged) {
  const [state, setState] = useState(null), [reading, setReading] = useState(true), [readError, setReadError] = useState('');
  const [notice, setNotice] = useState(''), [dialog, setDialog] = useState(null);
  const alive = useRef(false), read = useRef(null), write = useRef(null), operation = useRef(null);
  const isBusy = useCallback(() => Boolean(operation.current), []);
  useAccountLeave(Boolean(dialog), isBusy, 'Há um envio sem conclusão. Ele pode ter sido salvo. Confira os cadastros antes de tentar novamente após sair.');
  const load = useCallback(async () => {
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    setReading(true); setReadError('');
    try {
      const response = await api.get('/institutions/management', { signal: controller.signal, timeout: 15000 });
      if (!alive.current || controller.signal.aborted) return false;
      setState(managementState(response.data, user)); return true;
    } catch (error) {
      if (alive.current && !controller.signal.aborted) { setReadError(institutionalError(error)); if ([401, 403, 404].includes(error.response?.status)) setState(null); }
      return false;
    } finally { if (alive.current && !controller.signal.aborted) setReading(false); }
  }, [user.id, user.role]);
  useEffect(() => {
    alive.current = true; load();
    return () => { alive.current = false; read.current?.abort(); write.current?.abort(); operation.current?.resolve(false); operation.current = null; };
  }, [load]);
  const cancel = () => {
    if (!operation.current || !['review', 'rejected'].includes(dialog?.stage)) return;
    const current = operation.current; operation.current = null; setDialog(null); current.resolve(false);
  };
  const complete = async current => {
    if (!alive.current || operation.current !== current) return;
    operation.current = null; setDialog(null); setNotice(current.success); current.resolve(true);
    await load(); if (alive.current) { try { await onChanged?.(); } catch { /* A separate read failure must not turn a confirmed write into an uncertain one. */ } }
  };
  const send = async () => {
    const current = operation.current;
    if (!current || current.inFlight) return;
    current.inFlight = true; setDialog(presentation(current, 'saving'));
    const controller = new AbortController(); write.current = controller;
    try {
      const response = await api.request({ method: current.method || 'post', url: current.url, data: current.data, headers: { 'Idempotency-Key': current.key }, signal: controller.signal, timeout: 20000 });
      if (!alive.current || controller.signal.aborted) return;
      institutionalWriteResult(current, response.data); await complete(current);
    } catch (error) {
      if (!alive.current || controller.signal.aborted) return;
      const definite = !current.uncertain && [400, 401, 403, 404, 409, 422, 429].includes(error.response?.status);
      if (!definite) current.uncertain = true;
      setDialog(presentation(current, definite ? 'rejected' : 'uncertain', definite ? institutionalError(error) : 'A resposta não confirmou o envio. Ele pode ter sido salvo. Confira antes de repetir.'));
    } finally { current.inFlight = false; }
  };
  const check = async () => {
    const current = operation.current; if (!current || current.inFlight) return;
    current.inFlight = true; setDialog(presentation(current, 'checking', 'Consultando o registro deste envio…'));
    const controller = new AbortController(); write.current = controller;
    try {
      const response = await api.get('/institutions/management/operation', { headers: { 'Idempotency-Key': current.key }, signal: controller.signal, timeout: 15000 });
      if (!alive.current || controller.signal.aborted) return;
      if (institutionalReceipt(current, response.data)) await complete(current);
      else setDialog(presentation(current, 'uncertain', 'Ainda não há confirmação registrada. O envio pode estar em andamento. Aguarde e confira novamente ou repita exatamente o mesmo envio.'));
    } catch (error) { if (alive.current && !controller.signal.aborted) setDialog(presentation(current, 'uncertain', 'Não foi possível conferir agora. Nenhum novo cadastro foi enviado nesta consulta.')); }
    finally { current.inFlight = false; }
  };
  const mutate = command => {
    if (operation.current || reading || readError || !state) return Promise.resolve(false);
    setNotice('');
    try {
      const prepared = prepareInstitutionalWrite(state, command);
      const key = `institutional-pilot-${globalThis.crypto.randomUUID()}`;
      return new Promise(resolve => { const current = { ...prepared, key, resolve, inFlight: false, uncertain: false }; operation.current = current; setDialog(presentation(current, 'review')); });
    } catch (error) { setNotice(error.message); return Promise.resolve(false); }
  };
  // Only the operation reference owns the frozen request body (including a temporary password).
  // No request bodies, passwords or pending-operation keys are persisted in browser storage.
  const display = dialog && { stage: dialog.stage, kind: dialog.kind, summary: dialog.summary, message: dialog.message, uncertain: dialog.uncertain };
  return { state, reading, readError, notice, load, mutate, dialog: display, send, check, cancel,
    busyAction: operation.current?.action || (reading || readError ? 'read-unavailable' : '') };
}
