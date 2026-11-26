import axios from 'axios';
import { authStorage } from './authStorage.mjs';
import { handleApiSessionFailure } from './apiSessionFailure.mjs';

const api = axios.create({
  baseURL: '/api',
});

api.interceptors.request.use((config) => {
  const token = authStorage.token();
  const isStudentAssessmentRoute = config.url?.startsWith('/student-assessments/');
  if (token && !isStudentAssessmentRoute && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  handleApiSessionFailure
);

export default api;
