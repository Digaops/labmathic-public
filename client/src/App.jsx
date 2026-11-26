import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { useFeatureFlags } from './contexts/FeatureFlagsContext';
import Login from './pages/Login';
import NotFound from './pages/NotFound';
import OperationalBankAccess from './components/OperationalBankAccess';
import { portraitLoginPath, portraitReturnPath } from './services/networkPortraitQuery.mjs';

const Layout = lazy(() => import('./components/Layout'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Library = lazy(() => import('./pages/Library'));
const MaterialView = lazy(() => import('./pages/MaterialView'));
const Profile = lazy(() => import('./pages/Profile'));
const Favorites = lazy(() => import('./pages/Favorites'));
const Collections = lazy(() => import('./pages/Collections'));
const CollectionView = lazy(() => import('./pages/CollectionView'));
const SharedMaterial = lazy(() => import('./pages/SharedMaterial'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const TermsOfUse = lazy(() => import('./pages/TermsOfUse'));
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'));
const NumericReviews = lazy(() => import('./pages/admin/NumericReviews'));
const AdminMaterials = lazy(() => import('./pages/admin/AdminMaterials'));
const MaterialForm = lazy(() => import('./pages/admin/MaterialForm'));
const MaterialDrafts = lazy(() => import('./pages/admin/MaterialDrafts'));
const MaterialCuration = lazy(() => import('./pages/admin/MaterialCuration'));
const MaterialDraftReview = lazy(() => import('./pages/admin/MaterialDrafts').then(m => ({ default: m.MaterialDraftReview })));
const AdminCategories = lazy(() => import('./pages/admin/AdminCategories'));
const AdminUsers = lazy(() => import('./pages/admin/AdminUsers'));
const AdminReports = lazy(() => import('./pages/admin/AdminReports'));
const AdminActivityLog = lazy(() => import('./pages/admin/AdminActivityLog'));
const QuestionBank = lazy(() => import('./pages/QuestionBank'));
const QuestionSets = lazy(() => import('./pages/QuestionSets'));
const QuestionSetView = lazy(() => import('./pages/QuestionSetView'));
const SupportChat = lazy(() => import('./pages/SupportChat'));
const ContentIssues = lazy(() => import('./pages/ContentIssues'));
const SchoolCoordination = lazy(() => import('./pages/SchoolCoordination'));

const Classes = lazy(() => import('./pages/Classes'));
const LearningRecoveryPlans = lazy(() => import('./pages/LearningRecoveryPlans'));
const LessonPlans = lazy(() => import('./pages/LessonPlans'));
const LessonPlanEditor = lazy(() => import('./pages/LessonPlanEditor'));
const JoinClass = lazy(() => import('./pages/JoinClass'));
const StudentAssessment = lazy(() => import('./pages/StudentAssessment'));
const InstitutionalContext = lazy(() => import('./pages/InstitutionalContext'));
const NetworkPortrait = lazy(() => import('./pages/NetworkPortrait'));
const TypedQuestionLab = lazy(() => import('./pages/TypedQuestionLab'));
const TypedQuestionFeedbackLab = lazy(() => import('./pages/TypedQuestionFeedbackLab'));
const QuestionBankCatalogLab = lazy(() => import('./pages/QuestionBankCatalogLab'));
const PedagogicalCycle = lazy(() => import('./pages/PedagogicalCycle'));

function BankExperience({ feedback = false }) {
  return <OperationalBankAccess feedback={feedback}>{feedback ? <PedagogicalCycle /> : <QuestionBank />}</OperationalBankAccess>;
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to={portraitLoginPath(location)} replace />;
  return children;
}

function AdminRoute({ children }) {
  const { user, loading, isAdmin } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  if (!isAdmin) return <Navigate to="/" replace />;
  return children;  
}

function FeatureRoute({ flag, children, exampleTitle }) {
  const { user, loading: authLoading } = useAuth();
  const { loading, isEnabled, unavailable, refresh } = useFeatureFlags();
  if (authLoading || loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  if (!isEnabled(flag) && unavailable) return (
    <section role="alert" className="card mx-auto my-8 max-w-lg p-6">
      <h1 className="text-lg font-bold">Não foi possível confirmar a disponibilidade</h1>
      <p className="my-3 text-sm">Verifique a conexão. Nenhuma permissão nova será liberada sem confirmação do servidor.</p>
      <button type="button" onClick={refresh} className="btn-primary">Tentar novamente</button>
    </section>
  );
  if (!isEnabled(flag) && exampleTitle) return <section data-bank-access="examples_unavailable" className="mx-auto max-w-3xl space-y-3 bg-slate-50 px-4 py-4 text-slate-900 dark:bg-transparent dark:text-slate-100 sm:px-6">
    <h1 className="text-xl font-bold">{exampleTitle}</h1><p className="text-sm">Estes exemplos não estão disponíveis para sua conta neste momento. O banco de questões continua em um endereço separado.</p>
    <div className="flex flex-wrap gap-2"><button className="btn-outline" onClick={refresh}>Conferir acesso novamente</button><Link className="btn-primary" to="/banco-questoes">Abrir banco de questões</Link></div>
  </section>;
  if (!isEnabled(flag)) return <Navigate to="/" replace />;
  return children;
}

function LoadingScreen() {
  return (
    <div role="status" aria-live="polite" className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-50 via-white to-primary-50 dark:from-neutral-900 dark:via-neutral-900 dark:to-neutral-800">
      <div className="flex flex-col items-center gap-5 animate-fade-in">
        <img
          src="/logos/logo-labmathic-mark.png"
          alt="LabMathic"
          className="h-14 w-auto object-contain mb-2"
        />
        <div className="relative">
          <div className="w-10 h-10 border-[3px] border-primary-100 rounded-full" />
          <div className="absolute inset-0 w-10 h-10 border-[3px] border-transparent border-t-primary-500 rounded-full animate-spin" />
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-300">Carregando...</p>
      </div>
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingScreen />;

  return (
    <Suspense fallback={<LoadingScreen />}>
    <Routes>
      <Route path="/login" element={user ? <Navigate to={portraitReturnPath(location.search)} replace /> : <Login />} />
      <Route path="/esqueci-senha" element={user ? <Navigate to="/" replace /> : <ForgotPassword />} />
      <Route path="/resetar-senha/:token" element={user ? <Navigate to="/" replace /> : <ResetPassword />} />
      <Route path="/compartilhado/:token" element={<SharedMaterial />} />
      <Route path="/privacidade" element={<PrivacyPolicy />} />
      <Route path="/termos-de-uso" element={<TermsOfUse />} />
      <Route path="/entrar-na-turma" element={<Suspense fallback={<LoadingScreen />}><JoinClass /></Suspense>} />
      <Route path="/responder" element={<Suspense fallback={<LoadingScreen />}><StudentAssessment /></Suspense>} />

      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Dashboard />} />
        <Route path="biblioteca" element={<Library />} />
        <Route path="material/:id" element={<MaterialView />} />
        <Route path="perfil" element={<Profile />} />
        <Route path="favoritos" element={<Favorites />} />
        <Route path="colecoes" element={<Collections />} />
        <Route path="colecoes/:id" element={<CollectionView />} />
        <Route path="banco-questoes" element={<QuestionBank />} />
        <Route path="banco-questoes/formatos" element={<FeatureRoute flag="question_bank.typed_preview" exampleTitle="Exemplos de formatos"><Suspense fallback={<LoadingScreen />}><TypedQuestionLab /></Suspense></FeatureRoute>} />
        <Route path="banco-questoes/devolutivas" element={<BankExperience feedback />} />
        <Route path="banco-questoes/revisao" element={<BankExperience />} />
        <Route path="exemplos/formatos" element={<FeatureRoute flag="question_bank.typed_preview" exampleTitle="Exemplos de formatos"><TypedQuestionLab /></FeatureRoute>} />
        <Route path="exemplos/devolutivas" element={<FeatureRoute flag="question_bank.feedback_preview" exampleTitle="Exemplos de devolutivas"><TypedQuestionFeedbackLab /></FeatureRoute>} />
        <Route path="exemplos/banco-questoes" element={<FeatureRoute flag="question_bank.catalog_preview" exampleTitle="Exemplos do Banco 2.0"><QuestionBankCatalogLab /></FeatureRoute>} />
        <Route path="simulados" element={<QuestionSets />} />
        <Route path="simulados/:id" element={<QuestionSetView />} />
        <Route path="fale-conosco" element={<SupportChat />} />
        <Route path="problemas-no-acervo" element={<FeatureRoute flag="content.issue_review"><ContentIssues /></FeatureRoute>} />
        <Route path="acompanhamento-escolar" element={<FeatureRoute flag="institutions.school_coordination"><SchoolCoordination /></FeatureRoute>} />
        <Route path="turmas" element={<FeatureRoute flag="classes.core"><Suspense fallback={<LoadingScreen />}><Classes /></Suspense></FeatureRoute>} />
        <Route path="recomposicao" element={<Suspense fallback={<LoadingScreen />}><LearningRecoveryPlans /></Suspense>} />
        <Route path="planejamento" element={<FeatureRoute flag="planning.lesson_planner"><Suspense fallback={<LoadingScreen />}><LessonPlans /></Suspense></FeatureRoute>} />
        <Route path="planejamento/novo" element={<FeatureRoute flag="planning.lesson_planner"><Suspense fallback={<LoadingScreen />}><LessonPlanEditor /></Suspense></FeatureRoute>} />
        <Route path="planejamento/:planPublicId" element={<FeatureRoute flag="planning.lesson_planner"><Suspense fallback={<LoadingScreen />}><LessonPlanEditor /></Suspense></FeatureRoute>} />
        <Route path="instituicoes" element={<FeatureRoute flag="institutions.read_model"><Suspense fallback={<LoadingScreen />}><InstitutionalContext /></Suspense></FeatureRoute>} />

        {/* Admin */}
        <Route path="retrato-da-rede" element={<FeatureRoute flag="institutions.network_portrait"><NetworkPortrait /></FeatureRoute>} />
        <Route path="admin" element={<AdminRoute><AdminDashboard /></AdminRoute>} />
        <Route path="admin/materiais" element={<AdminRoute><AdminMaterials /></AdminRoute>} />
        <Route path="admin/questoes-numericas/revisoes" element={<AdminRoute><FeatureRoute flag="question_bank.numeric_drafts"><NumericReviews /></FeatureRoute></AdminRoute>} />
        <Route path="admin/materiais/novo" element={<AdminRoute><MaterialForm /></AdminRoute>} />
        <Route path="admin/materiais/rascunhos" element={<AdminRoute><MaterialDrafts /></AdminRoute>} />
        <Route path="admin/materiais/:id/habilidades" element={<AdminRoute><MaterialCuration /></AdminRoute>} />
        <Route path="admin/materiais/rascunhos/novo" element={<AdminRoute><MaterialForm draftMode /></AdminRoute>} />
        <Route path="admin/materiais/rascunhos/:draftId" element={<AdminRoute><MaterialDraftReview /></AdminRoute>} />
        <Route path="admin/materiais/rascunhos/:draftId/editar" element={<AdminRoute><MaterialForm draftMode /></AdminRoute>} />
        <Route path="admin/materiais/:id/editar" element={<AdminRoute><MaterialForm /></AdminRoute>} />
        <Route path="admin/categorias" element={<AdminRoute><AdminCategories /></AdminRoute>} />
        <Route path="admin/usuarios" element={<AdminRoute><AdminUsers /></AdminRoute>} />
        <Route path="admin/relatorios" element={<AdminRoute><AdminReports /></AdminRoute>} />
        <Route path="admin/atividades" element={<AdminRoute><AdminActivityLog /></AdminRoute>} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
    </Suspense>
  );
}
