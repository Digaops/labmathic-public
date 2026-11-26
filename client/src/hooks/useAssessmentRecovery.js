import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import { createAssessmentRecovery } from '../services/assessmentRecovery.mjs';
import { parseStudentPortal } from '../services/studentAssessmentView.mjs';

export default function useAssessmentRecovery(token, initialPortal) {
  const controller = useRef(null);
  const initial = useRef(initialPortal);
  initial.current = initialPortal;
  const [state, setState] = useState(null);
  useEffect(() => {
    setState(null);
    if (!token) return undefined;
    const recovery = createAssessmentRecovery({
      onChange: setState,
      canAutoRetry: () => navigator.onLine !== false && document.visibilityState !== 'hidden',
      request: async (method, path, data, signal) => parseStudentPortal((await api.request({
        method, url: '/student-assessments' + path, data, signal, timeout: 15000,
        headers: { Authorization: 'Bearer ' + token },
      })).data),
    });
    controller.current = recovery;
    const resume = () => { if (document.visibilityState !== 'hidden') recovery.retry(); };
    const offline = () => recovery.offline();
    const warn = (event) => {
      const snapshot = recovery.snapshot();
      if (snapshot.pendingIds.length || snapshot.uncertain || snapshot.hasRecoveryCopy) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('online', resume);
    window.addEventListener('offline', offline);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('beforeunload', warn);
    recovery.start(initial.current);
    return () => {
      recovery.dispose();
      if (controller.current === recovery) controller.current = null;
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', offline);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('beforeunload', warn);
    };
  }, [token]);
  return { state, controller };
}
