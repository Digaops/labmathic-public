import { authStorage } from './authStorage.mjs';
import { portraitLoginPath } from './networkPortraitQuery.mjs';

// Registered directly in api.js. Kept transport-independent so the backend CI
// can exercise the real session behavior without installing the frontend stack.
export function handleApiSessionFailure(error) {
  const isAuthRoute = error.config?.url?.startsWith('/auth/');
  const isStudentAssessmentRoute = error.config?.url?.startsWith('/student-assessments/');
  const sentToken = error.config?.headers?.Authorization?.replace(/^Bearer /, '');
  if (error.response?.status === 401 && !isAuthRoute && !isStudentAssessmentRoute
      && sentToken && authStorage.clear(sentToken)) {
    authStorage.announce('expired');
    window.location.href = portraitLoginPath(window.location);
  }
  return Promise.reject(error);
}
