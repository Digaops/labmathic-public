import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './AuthContext';
import api from '../services/api';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { featureFailure, validatedFeatures } from '../services/featureAvailability.mjs';

const FeatureFlagsContext = createContext(null);
const KNOWN_FLAGS = [
  'question_bank.numeric_drafts',
  'classes.numeric_assessments',
  'content.issue_review',
  'institutions.school_coordination',
  'question_bank.ai_assistant',
  'institutions.network_portrait',
  'materials.draft_publication',
  'materials.bncc_curation',
  'classes.core',
  'classes.student_import',
  'classes.entry_codes',
  'classes.assessment_assignments',
  'classes.assessment_delivery',
  'classes.assessment_exemptions',
  'classes.assessment_results',
  'classes.student_assessment_portal',
  'classes.learning_recovery',
  'classes.student_feedback_release',
  'question_bank.diagnostic_generator',
  'planning.lesson_planner',
  'institutions.read_model',
  'institutions.management_pilot',
  'question_bank.typed_preview',
  'question_bank.feedback_preview',
  'question_bank.catalog_preview',
  'pedagogy.operational_cycle',
];

export function FeatureFlagsProvider({ children }) {
  const { user, loading: authLoading, announcementAccessId } = useAuth();
  const identity = user ? `${user.id}:${user.role}:${announcementAccessId}` : null;
  const [snapshot, setSnapshot] = useState({ identity, features: {}, loading: Boolean(user), status: 'loading' });
  const current = snapshot.identity === identity ? snapshot
    : { identity, features: {}, loading: Boolean(user), status: 'loading' };

  const loadFeatures = useCallback(async ({ signal }) => {
    if (!user) {
      return;
    }
    try {
      const response = await api.get(`/governance/features?keys=${KNOWN_FLAGS.join(',')}`, { signal, timeout: 15_000 });
      if (signal.aborted) return;
      const features = validatedFeatures(response.data?.features, KNOWN_FLAGS);
      setSnapshot({ identity, features, loading: false, status: 'ready' });
    } catch (error) {
      if (signal.aborted) return;
      setSnapshot(previous => previous.identity === identity
        ? { identity, ...featureFailure(previous, error.response?.status) } : previous);
      throw error;
    }
  }, [identity]);

  useEffect(() => {
    const offline = navigator.onLine === false;
    setSnapshot({ identity, features: {}, loading: Boolean(user) && !offline,
      status: offline ? 'unavailable' : 'loading' });
    const onOffline = () => setSnapshot(previous => previous.identity === identity
      ? { identity, ...featureFailure(previous) } : previous);
    window.addEventListener('offline', onOffline);
    return () => window.removeEventListener('offline', onOffline);
  }, [identity]);
  const refresh = useVisiblePolling(loadFeatures, { enabled: Boolean(user) && !authLoading, intervalMs: 60_000 });

  const value = useMemo(() => ({
    features: current.features,
    loading: current.loading,
    unavailable: current.status === 'unavailable',
    isEnabled: (key) => current.features[key] === true,
    refresh,
  }), [current, refresh]);

  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>;
}

export function useFeatureFlags() {
  const context = useContext(FeatureFlagsContext);
  if (!context) throw new Error('useFeatureFlags deve ser usado dentro de FeatureFlagsProvider');
  return context;
}
