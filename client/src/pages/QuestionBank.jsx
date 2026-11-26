import AssessmentDialog from '../components/AssessmentDialog';
import ContentIssueButton from '../components/ContentIssueButton';
import useReadOnlyResource from '../hooks/useHomeResource';
import useMaterialAction from '../hooks/useMaterialAction';
import { readBankQuery, bankSearchParams, bankRequestPath, parseBankOptions, parseBankSkills, parseBankPage, parseBankQuestion } from '../services/questionBankView.mjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Search,
  Save,
  X,
  CheckCircle,
  Circle,
  FileText,
  Image as ImageIcon,
  Filter,
  ChevronLeft,
  ChevronRight,
  Eye,
  ClipboardList,
  Pencil,
  Power,
  PowerOff,
  Trash2,
  BadgePlus,
  Target,
} from 'lucide-react';
import api from '../services/api';
import { imageAccept, imageUploadHint, uploadSelectionError } from '../services/uploadSelection.mjs';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import QuestionImage from '../components/QuestionImage';
import TeacherQuestionManager from '../components/TeacherQuestionManager';
import DiagnosticGeneratorModal from '../components/DiagnosticGeneratorModal';
import CycleBankContext from '../components/CycleBankContext';
import { formatCount } from '../utils/pluralize';
import { quickActivityError, quickActivityQuestion, quickActivityTitle } from '../services/quickActivityView.mjs';
import { questionSetDraftStore, createQuestionSetSubmission, confirmedQuestionSetId } from '../services/questionSetDraft.mjs';
import { operationalBankState } from '../services/bankExperiences.mjs';
import { authStorage } from '../services/authStorage.mjs';

const editorialStageLabels = {
  prerequisite: 'Conhecimentos de entrada',
  application: 'Aplicação',
  reasoning: 'Raciocínio',
  practice: 'Prática guiada',
  verification: 'Verificação da aprendizagem',
};

export default function QuestionBank() {
  const { user } = useAuth();
  return <QuestionBankWorkspace key={user?.id} />;
}
function QuestionBankWorkspace() {
  const toast = useToast();
  const { user } = useAuth();
  const flags = useFeatureFlags();
  const { isEnabled } = flags;
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';
  const [searchParams, setSearchParams] = useSearchParams();
  const operational = user?.role === 'professor' && isEnabled('pedagogy.operational_cycle');
  // Preserve the teacher's intent while access flags are loading or unavailable.
  const cycleClassId = user?.role === 'professor' ? searchParams.get('turma') || '' : '';
  const quickActivity = user?.role === 'professor' && searchParams.get('atividade') === 'rapida';
  const questionSetUrl = id => `/simulados/${id}?${new URLSearchParams({ ...(cycleClassId ? { turma: cycleClassId } : {}), ...(quickActivity ? { atividade: 'rapida' } : {}) })}`;
  const showAuthorQuestions = !isAdmin && searchParams.get('tab') === 'author';
  const authorCreateRequested = showAuthorQuestions && searchParams.get('create') === '1';

  const openBankQuestions = useCallback(() => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('tab');
    nextParams.delete('create');
    setSearchParams(nextParams);
  }, [searchParams, setSearchParams]);

  const openAuthorQuestions = useCallback((openCreate = false) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('tab', 'author');
    if (openCreate) nextParams.set('create', '1');
    else nextParams.delete('create');
    setSearchParams(nextParams);
  }, [searchParams, setSearchParams]);

  const handleAuthorCreateOpened = useCallback(() => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('tab', 'author');
    nextParams.delete('create');
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const query = useMemo(() => readBankQuery(searchParams, isAdmin), [searchParams, isAdmin]);
  const gradeId = query.grade_id, unitId = query.unit_id, skillId = query.skill_id, difficulty = query.difficulty, statusFilter = query.status;
  const [search, setSearch] = useState(query.search);
  const [filtersOpen, setFiltersOpen] = useState(quickActivity);
  const draftStore = useMemo(() => questionSetDraftStore(user?.id), [user?.id]);
  const editorToken = useRef(authStorage.token());
  const [restored] = useState(() => draftStore.inspect());
  const restoredDraft = restored.draft;
  const [unreadableDraft, setUnreadableDraft] = useState(['invalid', 'unavailable'].includes(restored.status));
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pendingContext = useRef(restoredDraft?.pending ? restoredDraft.context : null);
  const restoreContext = useRef(true);
  const submission = useRef(null);
  if (!submission.current) submission.current = createQuestionSetSubmission(restoredDraft?.pending);
  const [selectedIds, setSelectedIds] = useState(restoredDraft?.selectedIds || []);
  const [selectedQuestionSettings, setSelectedQuestionSettings] = useState(restoredDraft?.selected || {});
  const [showSetModal, setShowSetModal] = useState(Boolean(restoredDraft?.pending || (searchParams.get('revisar') === '1' && restoredDraft?.selectedIds.length)));
  const [showDiagnosticModal, setShowDiagnosticModal] = useState(false);
  const [setForm, setSetForm] = useState(restoredDraft?.form || { title: '', description: '', is_public: false });
  const [expandedQuestionId, setExpandedQuestionId] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState(null);
  const [editingMode, setEditingMode] = useState('edit');
  const [questionImageFile, setQuestionImageFile] = useState(null);
  const [questionImagePreview, setQuestionImagePreview] = useState('');
  const [writeError, setWriteError] = useState('');
  const [editError, setEditError] = useState('');
  const [setError, setSetError] = useState('');
  const [setUncertain, setSetUncertain] = useState(Boolean(restoredDraft?.pending));
  const [setTerminal, setSetTerminal] = useState(restoredDraft?.pending?.terminal || null);
  const [draftStorageFailed, setDraftStorageFailed] = useState(false);
  const [draftRestored, setDraftRestored] = useState(Boolean(restoredDraft));
  const [operation, setOperation] = useState('');
  const [opening, setOpening] = useState(false);
  const editRead = useRef(null), editorDirty = useRef(false), editTrigger = useRef(null);
  const resultHeading = useRef(null), focusAfterPage = useRef(false), filterButton = useRef(null);
  const editAlertRef = useRef(null), setAlertRef = useRef(null);
  useEffect(() => { const el = editError && showEditModal ? editAlertRef.current : setError && showSetModal ? setAlertRef.current : null; el?.focus({ preventScroll: true }); el?.scrollIntoView({ block: 'nearest' }); }, [editError, setError, showEditModal, showSetModal]);
  const action = useMaterialAction();
  const savingSet = action.busy && operation === 'set';
  const savingEdit = action.busy && operation === 'edit';
  function persistDraft() {
    if (!mounted.current || authStorage.token() !== editorToken.current || unreadableDraft) return false;
    return draftStore.write({ selectedIds, selected: selectedQuestionSettings, form: setForm,
      context: pendingContext.current || { classId: cycleClassId, quick: quickActivity }, pending: submission.current.pending });
  }
  useEffect(() => {
    if (!restoreContext.current) return;
    restoreContext.current = false;
    const next = new URLSearchParams(searchParams);
    next.delete('revisar');
    if (restoredDraft?.context && (restoredDraft.pending || (!searchParams.has('turma') && !searchParams.has('atividade')))) {
      if (restoredDraft.context.classId) next.set('turma', restoredDraft.context.classId); else next.delete('turma');
      if (restoredDraft.context.quick) next.set('atividade', 'rapida'); else next.delete('atividade');
    }
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [restoredDraft, searchParams, setSearchParams]);
  useEffect(() => { setDraftStorageFailed(!persistDraft()); }, [draftStore, selectedIds, selectedQuestionSettings, setForm, setUncertain, cycleClassId, quickActivity, unreadableDraft]);
  useEffect(() => {
    const warn = event => {
      if (submission.current.pending || (draftStorageFailed && (selectedIds.length || setForm.title || setForm.description))) {
        event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draftStorageFailed, selectedIds.length, setForm.title, setForm.description]);
  const identity = user?.id;
  const enabled = !showAuthorQuestions;
  const gradeResource = useReadOnlyResource(enabled ? '/question-bank/grades' : null, identity, parseBankOptions);
  const gradeParam = gradeId === 'mine' ? 'my_grades=1' : gradeId ? 'grade_id=' + gradeId : '';
  const unitResource = useReadOnlyResource(enabled ? '/question-bank/units' + (gradeParam ? '?' + gradeParam : '') : null, identity, parseBankOptions);
  const skillParams = [gradeParam, unitId ? 'unit_id=' + unitId : ''].filter(Boolean).join('&');
  const skillResource = useReadOnlyResource(enabled ? '/question-bank/skills' + (skillParams ? '?' + skillParams : '') : null, identity, parseBankSkills);
  const editorSkillResource = useReadOnlyResource(isAdmin && showEditModal ? '/question-bank/skills' : null, identity, parseBankSkills);
  const resource = useReadOnlyResource(enabled ? bankRequestPath(query) : null, identity, parseBankPage);
  const grades = gradeResource.data || [], units = unitResource.data || [], skills = skillResource.data || [];
  const editorSkills = editorSkillResource.data || [];
  const editorSelectedSkill = editorSkills.find(skill => String(skill.id) === String(editingQuestion?.skill_id));
  const selectedFilterSkill = skills.find(skill => String(skill.id) === skillId);
  const questions = resource.data?.data || [];
  const loading = resource.status === 'loading', error = resource.status === 'error';
  const pagination = resource.data?.pagination || { page: query.page, limit: 10, total: 0, totalPages: 1 };
  const filterResources = [['anos escolares', gradeResource], ['unidades temáticas', unitResource], ['habilidades BNCC', skillResource]];
  const loadQuestions = resource.retry;
  useEffect(() => setSearch(query.search), [query.search]);
  useEffect(() => () => editRead.current?.abort(), []);
  useEffect(() => () => { if (questionImagePreview.startsWith('blob:')) URL.revokeObjectURL(questionImagePreview); }, [questionImagePreview]);
  useEffect(() => {
    if (resource.status === 'ready' && query.page > Math.max(1, pagination.totalPages)) {
      setSearchParams(bankSearchParams(searchParams, { ...query, page: Math.max(1, pagination.totalPages) }), { replace: true });
      return;
    }
    if (focusAfterPage.current && resource.status !== 'loading') {
      focusAfterPage.current = false;
      resultHeading.current?.focus({ preventScroll: true });
      resultHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [resource.status, pagination.totalPages, query.page, searchParams]);
  function updateQuery(patch) {
    setExpandedQuestionId(null);
    setSearchParams(bankSearchParams(searchParams, { ...query, page: 1, ...patch }));
  }
  function closeEditor() {
    if (savingEdit || (editorDirty.current && !window.confirm('Sair sem salvar as alterações desta questão?'))) return;
    setShowEditModal(false); setEditingQuestion(null); setQuestionImageFile(null); setQuestionImagePreview(''); setEditError('');
    requestAnimationFrame(() => { if (editTrigger.current?.isConnected) editTrigger.current.focus({ preventScroll: true }); });
  }
  function closeSet() { if (!savingSet) setShowSetModal(false); }
  function discardSetDraft() {
    if (savingSet || !window.confirm(submission.current.pending || unreadableDraft
      ? 'Descartar este rascunho? Se o envio anterior foi salvo, o simulado continuará em Meus simulados. Confira a lista antes de criar outro.'
      : 'Descartar a seleção de questões e o título deste rascunho?')) return;
    if (!draftStore.clear()) { toast.error('O navegador não permitiu descartar o rascunho. Confira as permissões de armazenamento e tente novamente.'); return; }
    submission.current.confirmed(); pendingContext.current = null; setUnreadableDraft(false); setSetUncertain(false); setSetTerminal(null); setSetError('');
    setSelectedIds([]); setSelectedQuestionSettings({}); setSetForm({ title: '', description: '', is_public: false });
    setShowSetModal(false); setDraftRestored(false);
  }
  function changeActivityMode(quick) {
    const next = new URLSearchParams(searchParams);
    if (quick) next.set('atividade', 'rapida'); else next.delete('atividade');
    setSearchParams(next); setFiltersOpen(true);
  }
  function reviewSelection() {
    if (quickActivity && !submission.current.pending) {
      const error = quickActivityError(selectedQuestions);
      if (error) { toast.error(error); return; }
      setSetForm(current => ({ ...current, title: current.title || quickActivityTitle(selectedQuestions) }));
    }
    setShowSetModal(true);
  }
  function showEditError(message) { setEditError(message); toast.error(message); }
  const developmentSpaceOptions = [
    { value: 'none', label: 'Não exige espaço' },
    { value: 'small', label: 'Pequeno' },
    { value: 'medium', label: 'Médio' },
    { value: 'large', label: 'Grande' },
  ];

  const developmentSpaceLabel = {
    none: 'Sem espaço de resolução',
    small: 'Espaço pequeno',
    medium: 'Espaço médio',
    large: 'Espaço grande',
  };
  function handleGradeChange(value) { updateQuery({ grade_id: value, unit_id: '', skill_id: '' }); }
  function handleUnitChange(value) { updateQuery({ unit_id: value, skill_id: '' }); }
  function handleSkillChange(value) { updateQuery({ skill_id: value }); }
  function handleDifficultyChange(value) { updateQuery({ difficulty: value }); }
  function handleStatusFilterChange(value) { updateQuery({ status: value }); }
  function clearFilters() { setSearch(''); updateQuery({ grade_id: '', unit_id: '', skill_id: '', difficulty: '', status: '', search: '' }); }
  function removeSelected(questionId) {
    if (savingSet || submission.current.pending) return;
    setSelectedIds(current => current.filter(id => id !== questionId));
    setSelectedQuestionSettings(current => { const next = { ...current }; delete next[questionId]; return next; });
  }
  function toggleQuestion(questionId) {
    if (savingSet || submission.current.pending) return;
    const question = questions.find(item => item.id === questionId);
    if (!question || question.status === 'inactive' || (isAdmin && question.editorial)) return;
    if (selectedIds.includes(questionId)) { removeSelected(questionId); return; }
    if (quickActivity) {
      const error = quickActivityError([...selectedIds.map(id => selectedQuestionSettings[id]), { ...question, ...quickActivityQuestion(question) }]);
      if (error) { toast.error(error); return; }
    }
    if (selectedIds.length >= 100) { toast.error('Um simulado pode ter até 100 questões.'); return; }
    setSelectedIds(current => [...new Set([...current, questionId])]);
    setSelectedQuestionSettings(current => ({ ...current, [questionId]: {
      id: questionId, question_code: question.question_code, statement: question.statement,
      image_path: question.image_path, source: question.source || 'official', show_image: Boolean(question.image_path),
      editorial_pilot: question.editorial?.state === 'pilot',
      ...quickActivityQuestion(question),
    } }));
  }
  function toggleSelectedQuestionImage(questionId) {
    if (savingSet || submission.current.pending) return;
    setSelectedQuestionSettings(current => ({ ...current, [questionId]: { ...current[questionId], show_image: !current[questionId]?.show_image } }));
  }
  function toggleQuestionStatus(question) {
    if (action.busy) return;
    const nextStatus = question.status === 'inactive' ? 'active' : 'inactive';
    if (!window.confirm(`${nextStatus === 'active' ? 'Ativar' : 'Desativar'} a questão ${question.question_code}? Avaliações já aplicadas serão preservadas.`)) return;
    setOperation('status'); setWriteError('');
    action.run(async () => {
      await api.patch(`/question-bank/questions/${question.id}/status`, { status: nextStatus }, { timeout: 15000 });
      if (nextStatus === 'inactive') removeSelected(question.id);
    }, { refresh: loadQuestions, onError: setWriteError, message: nextStatus === 'active' ? 'Questão ativada.' : 'Questão desativada.' });
  }
  function registerEditorialReview(question) {
    if (action.busy || question.editorial?.state !== 'pilot' || question.reviewed) return;
    if (!window.confirm('Você conferiu a habilidade, resolveu a questão e verificou o gabarito e as demais alternativas?')) return;
    setWriteError('');
    action.run(async () => {
      const { data } = await api.patch(`/question-bank/questions/${question.id}/reviewed`, { reviewed: true }, { timeout: 15000 });
      if (data?.id !== question.id || ![true, 1].includes(data.reviewed)) throw new Error('Revisão sem confirmação.');
    }, { refresh: loadQuestions, onError: setWriteError, message: 'Revisão pedagógica registrada.' });
  }
  function changePage(nextPage) {
    if (loading || nextPage < 1 || nextPage > pagination.totalPages) return;
    focusAfterPage.current = true; updateQuery({ page: nextPage });
  }

  function setQuestionImage(file) {
    const error = uploadSelectionError(file, 'image');
    if (error) return showEditError(error);

    setQuestionImageFile(file || null);
    setQuestionImagePreview(file ? URL.createObjectURL(file) : '');

    if (file) {
      updateEditingField('remove_image', false);
    }
  }

  function removeQuestionImage() {

    setQuestionImageFile(null);
    setQuestionImagePreview('');
    updateEditingField('image_path', '');
    updateEditingField('remove_image', true);
  }

  function openNewQuestion(event) {
    editTrigger.current = event.currentTarget;
    editorDirty.current = false; setEditError('');
    setEditingMode('create');
    setQuestionImageFile(null);
    setQuestionImagePreview('');

    setEditingQuestion({
      id: null,
      question_code: '',
      skill_id: skillId || skills[0]?.id || '',
      statement: '',
      support_text: '',
      development_space: 'none',
      difficulty: 'media',
      question_type: 'multiple_choice',
      official_explanation: '',
      image_path: '',
      remove_image: false,
      status: 'active',
      reviewed: false,
      options: [
        {
          option_label: 'A',
          option_text: '',
          is_correct: 1,
          sort_order: 1,
        },
        {
          option_label: 'B',
          option_text: '',
          is_correct: 0,
          sort_order: 2,
        },
        {
          option_label: 'C',
          option_text: '',
          is_correct: 0,
          sort_order: 3,
        },
        {
          option_label: 'D',
          option_text: '',
          is_correct: 0,
          sort_order: 4,
        },
      ],
    });

    setShowEditModal(true);
  }

  async function openEditQuestion(selected, trigger) {
    if (opening || action.busy) return;
    editTrigger.current = trigger;
    const controller = new AbortController(); editRead.current?.abort(); editRead.current = controller;
    setOpening(true); setWriteError('');
    let question;
    try {
      question = parseBankQuestion((await api.get('/question-bank/questions/' + selected.id, { signal: controller.signal, timeout: 15000 })).data);
      if (controller.signal.aborted) return;
    } catch {
      if (!controller.signal.aborted) setWriteError('Não foi possível abrir a questão para edição. Atualize a lista e tente novamente.');
      return;
    } finally { if (!controller.signal.aborted) setOpening(false); }
    editorDirty.current = false; setEditError('');
    setEditingMode('edit');
    setQuestionImageFile(null);
    setQuestionImagePreview(question.image_path ? `/uploads/${question.image_path}` : '');
    setEditingQuestion({
      id: question.id,
      question_code: question.question_code || '',
      skill_id: question.skill_id || '',
      statement: question.statement || '',
      support_text: question.support_text || '',
      development_space: question.development_space || 'none',
      difficulty: question.difficulty || 'media',
      question_type: question.question_type || 'multiple_choice',
      official_explanation: question.official_explanation || '',
      image_path: question.image_path || '',
      remove_image: false,
      status: question.status || 'active',
      reviewed: !!question.reviewed,
      options: (question.options || []).map((option) => ({
        option_label: option.option_label,
        option_text: option.option_text || '',
        is_correct: Number(option.is_correct) === 1 ? 1 : 0,
        sort_order: option.sort_order || 1,
      })),
    });

    setShowEditModal(true);
  }

  function updateEditingField(field, value) {
    editorDirty.current = true;
    setEditingQuestion((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function updateEditingOption(index, field, value) {
    editorDirty.current = true;
    setEditingQuestion((current) => {
      const options = [...current.options];

      options[index] = {
        ...options[index],
        [field]: value,
      };

      return {
        ...current,
        options,
      };
    });
  }

  function setCorrectOption(optionLabel) {
    editorDirty.current = true;
    setEditingQuestion((current) => ({
      ...current,
      options: current.options.map((option) => ({
        ...option,
        is_correct: option.option_label === optionLabel ? 1 : 0,
      })),
    }));
  }

    async function saveEditedQuestion() {
      if (!editingQuestion || action.busy) return;
      setEditError('');

      if (!editingQuestion.question_code.trim()) {
        showEditError('Código da questão é obrigatório.');
        return;
      }

      if (!editingQuestion.statement.trim()) {
        showEditError('Enunciado é obrigatório.');
        return;
      }

      if (!editingQuestion.skill_id) {
        showEditError('Habilidade BNCC é obrigatória.');
        return;
      }

      const emptyOption = editingQuestion.options.find((option) => !option.option_text.trim());

      if (emptyOption) {
        showEditError(`Preencha o texto da alternativa ${emptyOption.option_label}.`);
        return;
      }

      const correctCount = editingQuestion.options.filter((option) => Number(option.is_correct) === 1).length;

      if (correctCount !== 1) {
        showEditError('A questão deve ter exatamente uma alternativa correta.');
        return;
      }

      const payload = {
        question_code: editingQuestion.question_code.trim(),
        skill_id: Number(editingQuestion.skill_id),
        statement: editingQuestion.statement.trim(),
        support_text: editingQuestion.support_text.trim() || null,
        development_space: editingQuestion.development_space || 'none',
        difficulty: editingQuestion.difficulty,
        question_type: 'multiple_choice',
        official_explanation: editingQuestion.official_explanation.trim() || null,
        status: editingQuestion.status,
        reviewed: editingQuestion.reviewed,
        options: editingQuestion.options.map((option, index) => ({
          option_label: option.option_label,
          option_text: option.option_text.trim(),
          is_correct: Number(option.is_correct) === 1 ? 1 : 0,
          sort_order: index + 1,
        })),
      };

      const formData = new FormData();
      Object.entries(payload).forEach(([key, value]) => {
        if (key === 'options') {
          formData.append(key, JSON.stringify(value));
        } else if (value !== undefined && value !== null) {
          formData.append(key, String(value));
        }
      });

      if (questionImageFile) {
        formData.append('image', questionImageFile);
      }

      if (editingQuestion.remove_image) {
        formData.append('remove_image', '1');
      }

      setOperation('edit');
      action.run(async () => {
        const response = editingMode === 'create'
          ? await api.post('/question-bank/questions', formData, { timeout: 15000 })
          : await api.put(`/question-bank/questions/${editingQuestion.id}`, formData, { timeout: 15000 });
        parseBankQuestion(response.data);
      }, {
        onSuccess: () => {
          if (editingMode === 'edit') removeSelected(editingQuestion.id);
          setShowEditModal(false); setEditingQuestion(null); setQuestionImageFile(null); setQuestionImagePreview(''); editorDirty.current = false;
          requestAnimationFrame(() => resultHeading.current?.focus({ preventScroll: true }));
        },
        onError: setEditError, refresh: loadQuestions,
        message: editingMode === 'create' ? 'Questão criada.' : 'Questão atualizada. Se necessário, selecione-a novamente para o simulado.',
      });
    }

  function createQuestionSet() {
    if (action.busy || submission.current.terminal) return;
    setSetError('');
    if (unreadableDraft) { setSetError('Confira o rascunho anterior no Banco de questões antes de começar outro envio.'); return; }
    if (authStorage.token() !== editorToken.current) { setSetError('A sessão mudou. Entre novamente antes de salvar.'); return; }
    if (!submission.current.pending) {
      if (quickActivity && operationalBankState(user?.role, flags) !== 'operational') {
        setSetError('Aguarde a confirmação de acesso à atividade rápida ou tente novamente quando a conexão voltar.'); return;
      }
      if (!setForm.title.trim()) { setSetError('Informe um título para o simulado.'); return; }
      if (!selectedIds.length) { setSetError('Selecione pelo menos uma questão.'); return; }
      if (quickActivity && quickActivityError(selectedQuestions)) { setSetError(quickActivityError(selectedQuestions)); return; }
    }
    setOperation('set');
    let createdId, localError;
    action.run(async () => {
      try {
        const newSubmission = !submission.current.pending;
        if (newSubmission) pendingContext.current = { classId: cycleClassId, quick: quickActivity };
        const request = submission.current.begin({
          title: setForm.title.trim(), description: setForm.description.trim() || null,
          is_public: !quickActivity && !selectedHasAuthorQuestion && !selectedHasPilotQuestion && setForm.is_public,
          question_ids: selectedIds,
          question_items: selectedIds.map(questionId => ({ question_id: questionId, show_image: selectedQuestionSettings[questionId]?.show_image !== false })),
        });
        const stored = persistDraft();
        setDraftStorageFailed(!stored);
        if (!stored && newSubmission) {
          submission.current.confirmed(); pendingContext.current = null;
          localError = 'Não foi possível guardar a confirmação nesta aba. Nenhum simulado foi enviado. Libere espaço no navegador ou reduza a seleção antes de tentar novamente.';
          throw new Error(localError);
        }
        const response = await api.post('/question-bank/question-sets', request.body,
          { timeout: 15000, headers: { 'Idempotency-Key': request.key, Authorization: `Bearer ${editorToken.current}` } });
        if (!mounted.current || authStorage.token() !== editorToken.current) throw new Error('A sessão mudou.');
        createdId = confirmedQuestionSetId(response.data, user.id);
        if (!createdId) throw new Error('Simulado não confirmado.');
      } catch (error) {
        if (!mounted.current || authStorage.token() !== editorToken.current) throw error;
        setSetUncertain(localError ? false : submission.current.failed(error));
        setSetTerminal(submission.current.terminal);
        if (!submission.current.pending) pendingContext.current = null;
        setDraftStorageFailed(!persistDraft());
        throw error;
      }
    }, { onSuccess: () => {
      const context = pendingContext.current || { classId: cycleClassId, quick: quickActivity };
      submission.current.confirmed(); pendingContext.current = null; draftStore.clear(); setSetUncertain(false); setSetTerminal(null); setDraftRestored(false);
      setSelectedIds([]); setSelectedQuestionSettings({}); setSetForm({ title: '', description: '', is_public: false }); setShowSetModal(false);
      const next = new URLSearchParams({ ...(context.classId ? { turma: context.classId } : {}), ...(context.quick ? { atividade: 'rapida' } : {}) });
      navigate(`/simulados/${createdId}${next.size ? '?' + next : ''}`);
    }, onError: message => setSetError(localError || (submission.current.terminal
      ? message : submission.current.uncertain
      ? `${message} Use “Confirmar salvamento” para retomar o mesmo envio, sem criar outra cópia.` : message)),
      message: quickActivity ? 'Atividade privada salva em Meus simulados. Revise antes de aplicar.' : selectedHasAuthorQuestion || selectedHasPilotQuestion ? 'Simulado privado criado.' : 'Simulado criado.' });
  }

  function getDifficultyLabel(value) {
    if (value === 'facil') return 'Fácil';
    if (value === 'media') return 'Média';
    if (value === 'dificil') return 'Difícil';
    return value || '-';
  }

  const activeFilterCount = [
    gradeId,
    unitId,
    skillId,
    difficulty,
    statusFilter,
    query.search,
  ].filter(Boolean).length;

  function getQuestionStatusLabel(value) {
    return value === 'inactive' ? 'Inativa' : 'Ativa';
  }

  const selectedQuestions = selectedIds
    .map((questionId) => selectedQuestionSettings[questionId])
    .filter(Boolean);
  const selectedHasAuthorQuestion = selectedQuestions.some((question) => question.source === 'teacher');
  const selectedHasPilotQuestion = selectedQuestions.some((question) => question.editorial_pilot);

  function prepareAuthorSet(chosen) {
    if (unreadableDraft) { toast.error('Abra o Banco de questões e confira o aviso sobre o rascunho anterior antes de preparar outro.'); return false; }
    if (submission.current.pending) { toast.error('Retome a confirmação do simulado anterior antes de preparar outro.'); return false; }
    if ((selectedIds.length || setForm.title || setForm.description) && !window.confirm('Substituir o rascunho anterior pelas questões autorais selecionadas?')) return false;
    const nextSelected = Object.fromEntries(chosen.map(q => [q.id, { ...q, source: 'teacher', ...quickActivityQuestion(q) }]));
    setSelectedIds(chosen.map(q => q.id)); setSelectedQuestionSettings(nextSelected);
    setSetForm({ title: '', description: '', is_public: false }); setSetError(''); setDraftRestored(false);
    const next = new URLSearchParams(searchParams); next.delete('tab'); next.delete('create'); next.delete('atividade');
    setSearchParams(next); setShowSetModal(true);
    return true;
  }

  if (showAuthorQuestions) {
    return (
      <div data-question-bank className="mx-auto max-w-7xl space-y-3 bg-slate-50 px-3 py-3 dark:bg-transparent sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Banco de questões</h1>
          <ProfessorQuestionTabs activeTab="author" onBankClick={openBankQuestions} onAuthorClick={() => openAuthorQuestions(false)} />
        </div>
        {operational && cycleClassId && <CycleBankContext compact classId={cycleClassId} />}
        <TeacherQuestionManager autoOpenCreate={authorCreateRequested} onCreateHandled={handleAuthorCreateOpened} onPrepareSet={prepareAuthorSet} />
      </div>
    );
  }

  return (
    <div data-question-bank className="mx-auto max-w-7xl space-y-3 bg-slate-50 px-3 py-3 dark:bg-transparent sm:px-6">
      <header className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#111E31] sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-x-4">
        <h1 className="text-xl font-bold text-slate-900 dark:text-white sm:row-span-2 sm:self-center sm:text-2xl">Banco de questões</h1>
        <form role="search" aria-label="Buscar no banco de questões" className="mt-3 flex gap-2 sm:mt-0" onSubmit={event => { event.preventDefault(); updateQuery({ search: search.trim() }); }}>
          <label htmlFor="bank-search" className="sr-only">Buscar questão</label>
          <input id="bank-search" type="search" className="input min-w-0 flex-1" value={search} onChange={event => setSearch(event.target.value)} placeholder="Código ou enunciado" />
          <button type="submit" className="btn-primary shrink-0"><Search size={17} aria-hidden="true" /> Buscar</button>
        </form>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <button type="button" className="btn-outline" ref={filterButton} aria-expanded={filtersOpen} aria-controls="question-bank-filters" onClick={() => setFiltersOpen(value => !value)}><Filter size={17} /> Filtros{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}</button>
          {operational && !quickActivity && <button type="button" className="btn-outline" onClick={() => changeActivityMode(true)}>Atividade rápida · 1 a 5 questões</button>}
          <details className="relative">
            <summary className="cursor-pointer rounded-xl border border-slate-200 px-3 text-sm font-semibold dark:border-white/10">Mais ações</summary>
            <div className="mt-2 flex flex-wrap gap-2">
              {!isAdmin && isEnabled('question_bank.diagnostic_generator') && <button type="button" className="btn-outline" onClick={() => setShowDiagnosticModal(true)}><Target size={17} /> Gerar diagnóstico</button>}
              {!isAdmin && <button type="button" className="btn-outline" onClick={() => openAuthorQuestions(true)}><BadgePlus size={17} /> Criar questão autoral</button>}
              {isAdmin && <button type="button" className="btn-outline" disabled={action.busy || opening} onClick={openNewQuestion}><FileText size={17} /> Nova questão</button>}
              {operationalBankState(user?.role, flags, { feedback: true }) === 'operational' && !cycleClassId && <button type="button" className="btn-outline" onClick={() => navigate('/banco-questoes/devolutivas')}>Escolher turma para o ciclo</button>}
              <button type="button" className="btn-outline" onClick={() => navigate('/simulados' + (cycleClassId ? '?turma=' + encodeURIComponent(cycleClassId) : ''))}>Meus simulados</button>
            </div>
          </details>
        </div>
      </header>
      {(unreadableDraft || draftRestored || draftStorageFailed || setUncertain) && <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700 dark:border-white/10 dark:bg-[#111E31] dark:text-slate-200">
        <p>{unreadableDraft ? 'Não foi possível recuperar o rascunho anterior. Confira Meus simulados antes de descartá-lo e começar outro.' : setTerminal ? 'O envio anterior foi encerrado. Abra o rascunho para conferir a situação.' : setUncertain ? 'Há um envio aguardando confirmação. Retome para conferir o salvamento sem criar outra cópia.'
          : draftStorageFailed ? 'Este navegador não conseguiu guardar o rascunho. Mantenha a aba aberta até salvar.'
          : 'Sua seleção foi retomada nesta aba. Confira as questões antes de salvar.'}</p>
        {setUncertain && <button type="button" className="btn-primary" onClick={() => setShowSetModal(true)}>Retomar salvamento</button>}
        {unreadableDraft && <div className="flex flex-wrap gap-2"><button type="button" className="btn-outline" onClick={() => navigate('/simulados')}>Conferir Meus simulados</button><button type="button" className="btn-outline" onClick={discardSetDraft}>Descartar rascunho anterior</button></div>}
      </div>}
      {!isAdmin && <ProfessorQuestionTabs activeTab="bank" onBankClick={openBankQuestions} onAuthorClick={() => openAuthorQuestions(false)} />}
      {operational && cycleClassId && <CycleBankContext compact classId={cycleClassId} />}
      {quickActivity && <section aria-label="Preparar atividade rápida" className="rounded-xl border border-cyan-300 bg-cyan-50 p-3 text-sm text-slate-900 dark:border-cyan-400/30 dark:bg-[#111E31] dark:text-slate-100">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold">Atividade rápida · 1 a 5 questões</h2><button type="button" className="btn-outline" onClick={() => changeActivityMode(false)}>Usar modo simulado</button></div>
        <p className="mt-2">Escolha o ano e uma habilidade nos filtros. Leia as questões, selecione até cinco e confira antes de salvar.</p>
        <details className="mt-1"><summary className="cursor-pointer font-semibold">Como usar com a turma?</summary><p className="mt-1">A atividade fica em Meus simulados: você pode revisar, imprimir para usar em papel ou preparar uma aplicação na turma. Nada será aplicado automaticamente.</p><p className="mt-1 text-slate-600 dark:text-slate-300">Uma atividade curta ajuda a observar uma aprendizagem específica; sozinha, não representa tudo o que o estudante sabe.</p></details>
        {selectedIds.length > 0 && <p className="mt-2 font-semibold" role="status">{quickActivityError(selectedQuestions) || `${selectedIds.length} de 5 questões selecionadas · ${selectedQuestions[0]?.skill_code || ''}`}</p>}
      </section>}
      {selectedIds.length > 0 && <section aria-label="Seleção para o simulado" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cyan-300 bg-cyan-50 p-3 text-sm dark:border-cyan-400/30 dark:bg-cyan-400/10">
        <strong>{formatCount(selectedIds.length, 'questão selecionada', 'questões selecionadas')}</strong>
        <div className="flex flex-wrap gap-2">{quickActivity && quickActivityError(selectedQuestions) && <button type="button" className="btn-outline" onClick={() => setShowSetModal(true)}>Revisar seleção</button>}<button type="button" className="btn-primary" disabled={quickActivity && Boolean(quickActivityError(selectedQuestions))} onClick={reviewSelection}><Save size={17} /> {quickActivity ? 'Conferir atividade' : 'Conferir e gerar simulado'}</button></div>
      </section>}
      {writeError && <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100"><p>{writeError}</p><button type="button" className="btn-outline mt-2" disabled={loading || action.busy} onClick={loadQuestions}>Atualizar lista</button></div>}
      {filterResources.filter(([, r]) => r.status === 'error').map(([name, r]) => <div key={name} role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100"><p>Não foi possível carregar {name}. A busca por texto continua disponível.</p><button type="button" className="btn-outline mt-2" onClick={r.retry}>Recarregar {name}</button></div>)}
      {activeFilterCount > 0 && <div className="flex flex-wrap items-center gap-2 text-sm"><span>{query.search ? `Busca: “${query.search}”` : formatCount(activeFilterCount, 'filtro aplicado', 'filtros aplicados')}</span><button type="button" className="btn-outline" onClick={clearFilters}><X size={15} /> Limpar filtros</button></div>}
      {filtersOpen && <section id="question-bank-filters" aria-label="Filtros de questões" className="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#111E31]">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label><span className="label">Ano escolar</span><select aria-label="Ano escolar" className="input" value={gradeId} onChange={e => handleGradeChange(e.target.value)} disabled={gradeResource.status !== 'ready'}><option value="">Todos os anos</option>{!isAdmin && <option value="mine">Meus anos</option>}{gradeId && gradeId !== 'mine' && !grades.some(g => String(g.id) === gradeId) && <option value={gradeId}>Ano selecionado sem questões disponíveis</option>}{grades.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
          <label><span className="label">Unidade temática</span><select aria-label="Unidade temática" className="input" value={unitId} onChange={e => handleUnitChange(e.target.value)} disabled={unitResource.status !== 'ready'}><option value="">Todas as unidades</option>{units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label><span className="label">Habilidade BNCC</span><select aria-label="Habilidade BNCC" aria-describedby={selectedFilterSkill ? 'bank-filter-skill-description' : undefined} className="input" value={skillId} onChange={e => handleSkillChange(e.target.value)} disabled={skillResource.status !== 'ready'}><option value="">Todas as habilidades</option>{skills.map(s => <option key={s.id} value={s.id}>{s.code} — {s.description}</option>)}</select>{selectedFilterSkill && <p id="bank-filter-skill-description" className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-300">{selectedFilterSkill.code} — {selectedFilterSkill.description}</p>}</label>
          <label><span className="label">Dificuldade</span><select aria-label="Dificuldade" className="input" value={difficulty} onChange={e => handleDifficultyChange(e.target.value)}><option value="">Todas</option><option value="facil">Fácil</option><option value="media">Média</option><option value="dificil">Difícil</option></select></label>
          {isAdmin && <label><span className="label">Situação</span><select aria-label="Situação" className="input" value={statusFilter} onChange={e => handleStatusFilterChange(e.target.value)}><option value="">Todas</option><option value="active">Ativas</option><option value="inactive">Inativas</option></select></label>}
        </div>
        <button type="button" className="btn-outline mt-3" onClick={() => { setFiltersOpen(false); filterButton.current?.focus(); }}>Concluir filtros</button>
      </section>}

      <section aria-label="Questões encontradas" className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111E31]">
        <h2 ref={resultHeading} tabIndex={-1} className="border-b border-slate-200 px-3 py-3 text-sm font-semibold outline-none dark:border-white/10">{loading ? 'Buscando questões…' : error ? 'Não foi possível carregar as questões' : formatCount(pagination.total, 'questão encontrada', 'questões encontradas')}</h2>
        {loading ? <p role="status" className="p-4 text-sm">Carregando questões…</p>
          : error ? <div role="alert" className="p-4 text-sm"><p>A busca não foi concluída. Suas questões selecionadas continuam guardadas nesta tela.</p><button type="button" className="btn-outline mt-3" onClick={loadQuestions}>Tentar novamente</button></div>
          : questions.length > 0 ? <div className="divide-y divide-slate-200 dark:divide-white/10">{questions.map(question => <article data-bank-question={question.id} key={question.id} className={`border-l-4 p-3 sm:p-4 ${selectedIds.includes(question.id) ? 'border-l-cyan-500 bg-cyan-50/50 dark:bg-cyan-400/5' : 'border-l-transparent'}`}>
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <strong className="break-words text-cyan-800 dark:text-cyan-200">{question.question_code}</strong>
              <span className="text-slate-600 dark:text-slate-300">{question.grade_name} · {getDifficultyLabel(question.difficulty)}</span>
              {question.source === 'teacher' && <span className="text-violet-700 dark:text-violet-300">Autoral{isAdmin && question.creator_name ? ` · ${question.creator_name}` : ''}</span>}
              {question.editorial?.state === 'pilot' && <span className="text-cyan-800 dark:text-cyan-200">{editorialStageLabels[question.editorial.stage]}</span>}
              {isAdmin && question.editorial?.state === 'held' && <span className="font-semibold text-amber-800 dark:text-amber-200">Retirada de novas seleções</span>}
              {isAdmin && question.editorial?.state !== 'held' && <span className={question.status === 'inactive' ? 'text-rose-700 dark:text-rose-300' : 'text-slate-600 dark:text-slate-300'}>{getQuestionStatusLabel(question.status)} · {question.reviewed ? 'Revisada' : 'A revisar'}</span>}
            </div>
            <p className={`break-words text-[15px] font-medium leading-relaxed text-slate-900 dark:text-slate-100 ${expandedQuestionId === question.id ? 'whitespace-pre-line' : 'line-clamp-3'}`}>{question.statement}</p>
            {question.image_path && expandedQuestionId !== question.id && <span className="mt-2 flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300"><ImageIcon size={15} aria-hidden="true" /> Imagem de apoio nos detalhes</span>}
            <div className="mt-3 flex flex-wrap gap-2">
              {!(isAdmin && question.editorial) && <button type="button" className="btn-outline" disabled={question.status === 'inactive' || action.busy || setUncertain} aria-pressed={selectedIds.includes(question.id)} aria-label={`${selectedIds.includes(question.id) ? 'Remover seleção de' : 'Selecionar'} ${question.question_code}`} onClick={() => toggleQuestion(question.id)}>{selectedIds.includes(question.id) ? <CheckCircle size={17} /> : <Circle size={17} />}{question.status === 'inactive' ? 'Inativa' : selectedIds.includes(question.id) ? 'Selecionada' : 'Selecionar'}</button>}
              <button type="button" className="btn-outline" aria-expanded={expandedQuestionId === question.id} aria-controls={`bank-details-${question.id}`} onClick={() => setExpandedQuestionId(value => value === question.id ? null : question.id)}><Eye size={17} /> {expandedQuestionId === question.id ? 'Ocultar detalhes' : 'Ver questão e gabarito'}</button>
              {isAdmin && !question.editorial && <button type="button" className="btn-outline" disabled={opening || action.busy} onClick={event => openEditQuestion(question, event.currentTarget)}><Pencil size={17} /> Editar questão</button>}
            </div>
            {expandedQuestionId === question.id && <div id={`bank-details-${question.id}`} className="mt-3 space-y-3 border-t border-slate-200 pt-3 dark:border-white/10">
              {question.support_text && <section><h3 className="text-sm font-bold">Texto de apoio</h3><p className="mt-1 whitespace-pre-line break-words text-sm leading-relaxed">{question.support_text}</p></section>}
              {question.image_path && <QuestionImage src={`/uploads/${question.image_path}`} alt={`Imagem da questão ${question.question_code}`} variant="detail" />}
              <section><h3 className="mb-2 text-sm font-bold">Alternativas e gabarito</h3><div className="grid gap-2">{question.options.map(option => <div key={option.id || option.option_label} className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${Number(option.is_correct) === 1 ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-100' : 'border-slate-200 dark:border-white/10'}`}><strong className="shrink-0">{option.option_label}.</strong><div className="min-w-0 break-words">{option.option_text}{Number(option.is_correct) === 1 && <p className="mt-1 text-xs font-bold">Alternativa correta</p>}</div></div>)}</div></section>
              <section><h3 className="text-sm font-bold">Comentário pedagógico</h3><p className="mt-1 whitespace-pre-line break-words text-sm leading-relaxed">{question.official_explanation || 'Comentário pedagógico não informado.'}</p></section>
              <section><h3 className="text-sm font-bold">Habilidade BNCC</h3><p className="mt-1 break-words text-sm leading-relaxed">{question.skill_code || 'Código não informado'} — {question.skill_description || 'Descrição não informada.'}</p><p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{question.unit_name || 'Unidade não informada'} · {developmentSpaceLabel[question.development_space || 'none']}</p></section>
              {isAdmin && question.editorial?.state === 'held' && <p className="max-w-prose text-sm">{question.editorial.reason}</p>}
              {isAdmin && question.editorial?.state === 'pilot' && <div className="space-y-2">
                {question.editorial.rationales && <details className="max-w-prose text-sm">
                  <summary className="cursor-pointer font-semibold">Por que cada alternativa foi incluída?</summary>
                  <ul className="mt-2 space-y-2">
                    {Object.entries(question.editorial.rationales).map(([label, reason]) => <li key={label}><strong>{label}.</strong> {reason}</li>)}
                  </ul>
                </details>}
                {!question.reviewed && <button type="button" disabled={action.busy} className="btn-outline" onClick={() => registerEditorialReview(question)}>
                  Registrar revisão pedagógica
                </button>}
                {Boolean(question.reviewed) && question.status === 'inactive' && <p className="text-sm">Ao ativar, esta questão ficará disponível às contas docentes liberadas para o piloto.</p>}
              </div>}
              {isAdmin && question.editorial?.state !== 'held' && (question.editorial?.state !== 'pilot' || question.reviewed || question.status === 'active') && <button type="button" disabled={action.busy} className="btn-outline" onClick={() => toggleQuestionStatus(question)}>{question.status === 'inactive' ? <Power size={17} /> : <PowerOff size={17} />}{question.status === 'inactive' ? 'Ativar questão' : 'Desativar questão'}</button>}
              <ContentIssueButton targetType="question" targetId={question.id} targetLabel={question.question_code} />
            </div>}
          </article>)}</div>
          : <div className="p-4 text-sm"><h3 className="font-bold">Nenhuma questão encontrada</h3><p className="mt-1">Tente outro código ou enunciado, ou ajuste os filtros.</p></div>}
        {!loading && !error && pagination.totalPages > 1 && <nav aria-label="Páginas de questões" className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 p-3 dark:border-white/10">
          <button type="button" className="btn-outline" disabled={pagination.page <= 1} onClick={() => changePage(pagination.page - 1)}><ChevronLeft size={17} /> Anterior</button><span className="text-sm">{pagination.page} / {pagination.totalPages}</span><button type="button" className="btn-outline" disabled={pagination.page >= pagination.totalPages} onClick={() => changePage(pagination.page + 1)}>Próxima <ChevronRight size={17} /></button>
        </nav>}
      </section>

      {showSetModal && <AssessmentDialog title={quickActivity ? 'Conferir atividade rápida' : 'Gerar simulado'} onClose={closeSet} closeDisabled={savingSet}>
        <div className="bank-form space-y-3 p-3 sm:p-4">
          {quickActivity && <p className="text-sm">Confira se as questões atendem à sua turma. A atividade será privada e ficará em Meus simulados. Na próxima tela, revise também as respostas e escolha entre imprimir ou preparar a aplicação.</p>}
          {setError && <div ref={setAlertRef} tabIndex={-1} role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 outline-none dark:bg-amber-400/10 dark:text-amber-100"><p>{setError}</p>
          </div>}
          {setTerminal ? <div role="status" className="space-y-2 text-sm"><p>{setTerminal === 'question_set_deleted'
            ? 'O simulado deste envio foi excluído. Ele não será criado novamente ao confirmar.'
            : 'Este envio está associado a outros dados. Confira seus simulados antes de preparar outro.'}</p><p>Você pode descartar este rascunho e começar uma nova seleção.</p><button type="button" className="btn-outline" onClick={() => navigate('/simulados')}>Conferir meus simulados</button></div>
            : setUncertain && <div className="space-y-2 text-sm"><p>As questões e o título ficam preservados até confirmarmos este envio.</p><button type="button" className="btn-primary" disabled={savingSet} onClick={createQuestionSet}>{savingSet ? 'Confirmando…' : 'Confirmar salvamento'}</button></div>}
          <fieldset disabled={savingSet || setUncertain} className="space-y-3">
            <details open className="rounded-xl border border-slate-200 p-3 dark:border-white/10"><summary className="cursor-pointer font-bold">{formatCount(selectedIds.length, 'questão selecionada', 'questões selecionadas')}</summary>
              <div className="mt-2 divide-y divide-slate-200 dark:divide-white/10">{selectedQuestions.map(question => <div key={question.id} data-selected-question={question.id} className="py-3">
                <div className="flex items-start justify-between gap-2"><p className="min-w-0 break-words text-sm font-bold">{question.question_code}</p><button type="button" className="btn-outline shrink-0" aria-label={`Remover ${question.question_code} da seleção`} onClick={() => removeSelected(question.id)}><Trash2 size={16} /></button></div>
                <p className="mt-1 whitespace-pre-line break-words text-sm leading-relaxed">{question.statement}</p>
                {question.image_path && <QuestionImage src={`/uploads/${question.image_path}`} alt={`Imagem selecionada: ${question.question_code}`} variant="thumbnail" />}
                {question.image_path && <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={question.show_image} onChange={() => toggleSelectedQuestionImage(question.id)} /> Mostrar imagem desta questão no simulado</label>}
              </div>)}</div>
              {!selectedIds.length && <p className="mt-2 text-sm">Feche esta janela e selecione as questões que deseja usar.</p>}
            </details>
            <label className="block"><span className="label">{quickActivity ? 'Título da atividade' : 'Título do simulado'}</span><input className="input" maxLength={200} value={setForm.title} onChange={e => setSetForm(current => ({ ...current, title: e.target.value }))} placeholder="Ex.: Revisão de números — 6º ano" /></label>
            <label className="block"><span className="label">Observações (opcional)</span><textarea className="input min-h-24" maxLength={5000} value={setForm.description} onChange={e => setSetForm(current => ({ ...current, description: e.target.value }))} /></label>
            {!quickActivity && (selectedHasPilotQuestion
              ? <p className="text-sm">Este simulado ficará privado porque inclui questões do piloto.</p>
              : <label className="flex cursor-pointer items-start gap-2 text-sm"><input type="checkbox" checked={selectedHasAuthorQuestion ? false : setForm.is_public} disabled={selectedHasAuthorQuestion} onChange={e => setSetForm(current => ({ ...current, is_public: e.target.checked }))} /><span>{selectedHasAuthorQuestion ? 'Simulados com questão autoral são privados: apenas o autor e administradores podem vê-los.' : 'Compartilhar este simulado com outros professores'}</span></label>)}
            {quickActivity && quickActivityError(selectedQuestions) && <p role="status" className="text-sm">{quickActivityError(selectedQuestions)}</p>}
            {!setUncertain && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-3 dark:border-white/10"><button type="button" className="btn-outline" onClick={closeSet}>Continuar depois</button><button type="button" className="btn-primary" disabled={savingSet || !selectedIds.length || (quickActivity && Boolean(quickActivityError(selectedQuestions)))} onClick={createQuestionSet}><Save size={16} /> {savingSet ? 'Salvando…' : quickActivity ? 'Salvar e revisar atividade' : 'Salvar simulado'}</button></div>}
          </fieldset>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 text-sm dark:border-white/10"><p>{draftStorageFailed ? 'Rascunho disponível apenas enquanto esta tela estiver aberta.' : 'Rascunho guardado nesta aba. Ele é removido ao sair da conta.'}</p><button type="button" className="btn-outline" disabled={savingSet} onClick={discardSetDraft}>Descartar rascunho</button></div>
        </div>
      </AssessmentDialog>}
      {showEditModal && editingQuestion && <AssessmentDialog title={editingMode === 'create' ? 'Nova questão' : 'Editar questão'} onClose={closeEditor} closeDisabled={savingEdit} wide>
        <div className="bank-form p-3 sm:p-4">
          {editError && <p ref={editAlertRef} tabIndex={-1} role="alert" className="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 outline-none dark:bg-amber-400/10 dark:text-amber-100">{editError}</p>}
          {editorSkillResource.status === 'loading' && <p role="status" className="mb-3 text-sm">Carregando habilidades…</p>}
          {editorSkillResource.status === 'error' && <div role="alert" className="mb-3 text-sm"><p>Não foi possível carregar as habilidades. Seus campos foram preservados.</p><button type="button" className="btn-outline" onClick={editorSkillResource.retry}>Recarregar habilidades do editor</button></div>}
          <fieldset disabled={savingEdit || editorSkillResource.status !== 'ready'}>
            <div className="space-y-4">
              <section className="rounded-2xl border border-neutral-100 bg-neutral-50/60 p-3.5 dark:border-white/10 dark:bg-neutral-900/20 sm:p-4">
                <div className="mb-3">
                  <h3 className="text-sm font-bold text-neutral-800 dark:text-neutral-100">
                    Código e habilidade
                  </h3>
                  <p className="text-xs text-neutral-400">
                    Defina o código e vincule a questão à habilidade BNCC.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <div>
                    <label className="label">Código da questão</label>
                    <input
                      aria-label="Código da questão"
                      className="input"
                      value={editingQuestion.question_code}
                      onChange={(event) => updateEditingField('question_code', event.target.value)}
                      placeholder="Ex: EF01MA01-Q001"
                    />
                  </div>

                  <div>
                    <label className="label">Dificuldade</label>
                    <select
                      aria-label="Dificuldade"
                      className="input"
                      value={editingQuestion.difficulty}
                      onChange={(event) => updateEditingField('difficulty', event.target.value)}
                    >
                      <option value="facil">Fácil</option>
                      <option value="media">Média</option>
                      <option value="dificil">Difícil</option>
                    </select>
                  </div>

                  <div>
                    <label className="label">Situação</label>
                    <select
                      aria-label="Situação"
                      className="input"
                      value={editingQuestion.status}
                      onChange={(event) => updateEditingField('status', event.target.value)}
                    >
                      <option value="active">Ativa</option>
                      <option value="inactive">Inativa</option>
                    </select>
                  </div>
                </div>

                <div className="mt-3">
                  <label className="label">Habilidade BNCC</label>
                  <select
                    aria-label="Habilidade BNCC da questão"
                    aria-describedby={editorSelectedSkill ? 'bank-editor-skill-description' : undefined}
                    className="input"
                    value={editingQuestion.skill_id}
                    onChange={(event) => updateEditingField('skill_id', event.target.value)}
                  >
                    <option value="">Selecione a habilidade</option>
                    {editorSkills.map((skill) => (
                      <option key={skill.id} value={skill.id}>
                        {skill.code} — {skill.description}
                      </option>
                    ))}
                  </select>
                  {editorSelectedSkill && <p id="bank-editor-skill-description" className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                    {editorSelectedSkill.code} — {editorSelectedSkill.description}
                  </p>}
                </div>
              </section>

              <section className="rounded-2xl border border-neutral-100 bg-white p-3.5 dark:border-white/10 dark:bg-neutral-900/20 sm:p-4">
                <div className="mb-3">
                  <h3 className="text-sm font-bold text-neutral-800 dark:text-neutral-100">
                    Enunciado da questão
                  </h3>
                  <p className="text-xs text-neutral-400">
                    Escreva o comando principal e, se necessário, um texto de apoio.
                  </p>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="label">Enunciado</label>
                    <textarea
                      aria-label="Enunciado"
                      className="input min-h-[110px] sm:min-h-[130px]"
                      value={editingQuestion.statement}
                      onChange={(event) => updateEditingField('statement', event.target.value)}
                      placeholder="Digite o enunciado que será apresentado ao aluno."
                    />
                  </div>

                  <div>
                    <label className="label">Texto de apoio opcional</label>
                    <textarea
                      aria-label="Texto de apoio opcional"
                      className="input min-h-[78px] sm:min-h-[90px]"
                      value={editingQuestion.support_text}
                      onChange={(event) => updateEditingField('support_text', event.target.value)}
                      placeholder="Use este campo para contextualização, tabela, trecho ou instrução complementar."
                    />
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-neutral-100 bg-neutral-50/60 p-3.5 dark:border-white/10 dark:bg-neutral-900/20 sm:p-4">
                <div className="mb-3">
                  <h3 className="text-sm font-bold text-neutral-800 dark:text-neutral-100">
                    Imagem de apoio
                  </h3>
                  <p className="text-xs text-neutral-400">
                    Adicione uma imagem opcional para apoiar a leitura da questão.
                  </p>
                </div>

                {questionImagePreview ? (
                  <div className="rounded-2xl border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900/30">
                    <QuestionImage
                      src={questionImagePreview}
                      alt="Prévia da questão"
                      variant="preview"
                      className="mt-0"
                    />

                    <button
                      type="button"
                      onClick={removeQuestionImage}
                      className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
                    >
                      <Trash2 size={14} />
                      Remover imagem
                    </button>
                  </div>
                ) : (
                  <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-neutral-200 bg-white px-4 py-4 text-center transition-colors hover:border-primary-300 hover:bg-primary-50/40 dark:border-neutral-700 dark:bg-neutral-900/30 dark:hover:border-primary-500/40 dark:hover:bg-primary-500/10">
                    <ImageIcon size={24} className="mb-2 text-neutral-400" />
                    <span className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">
                      Anexar ilustração, gráfico ou cálculo
                    </span>
                    <span className="text-xs text-neutral-400">
                      {imageUploadHint}
                    </span>
                    <input
                      type="file"
                      className="sr-only"
                      aria-label="Anexar imagem da questão"
                      accept={imageAccept}
                      onChange={(event) => setQuestionImage(event.target.files?.[0] || null)}
                    />
                  </label>
                )}
              </section>

              <section className="rounded-2xl border border-neutral-100 bg-white p-3.5 dark:border-white/10 dark:bg-neutral-900/20 sm:p-4">
                <div className="mb-3">
                  <h3 className="text-sm font-bold text-neutral-800 dark:text-neutral-100">
                    Alternativas
                  </h3>
                  <p className="text-xs text-neutral-400">
                    Preencha as opções e marque uma alternativa correta.
                  </p>
                </div>

                <div className="space-y-2.5">
                  {editingQuestion.options.map((option, index) => (
                    <div
                      key={option.option_label}
                      className={`rounded-xl border p-2.5 sm:p-3 ${
                        Number(option.is_correct) === 1
                          ? 'border-green-200 bg-green-50/70 dark:border-green-500/25 dark:bg-green-500/10'
                          : 'border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900/30'
                      }`}
                    >
                      <div className="flex flex-col gap-3 md:flex-row md:items-center">
                        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-white text-sm font-bold text-neutral-700 shadow-sm dark:bg-white/10 dark:text-neutral-200">
                          {option.option_label}
                        </div>

                        <input
                          aria-label={`Alternativa ${option.option_label}`}
                          className="input min-w-0 flex-1"
                          value={option.option_text}
                          onChange={(event) => updateEditingOption(index, 'option_text', event.target.value)}
                          placeholder={`Texto da alternativa ${option.option_label}`}
                        />

                        <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm font-semibold text-neutral-600 hover:bg-white dark:text-neutral-300 dark:hover:bg-white/5">
                          <input
                            type="radio"
                            name="correct_option"
                            aria-label={`Alternativa correta ${option.option_label}`}
                            checked={Number(option.is_correct) === 1}
                            onChange={() => setCorrectOption(option.option_label)}
                            className="w-4 h-4 text-primary-500 focus:ring-primary-500"
                          />
                          Correta
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-2xl border border-neutral-100 bg-neutral-50/60 p-3.5 dark:border-white/10 dark:bg-neutral-900/20 sm:p-4">
                <div className="mb-3">
                  <h3 className="text-sm font-bold text-neutral-800 dark:text-neutral-100">
                    Comentário pedagógico
                  </h3>
                  <p className="text-xs text-neutral-400">
                    Campo opcional para explicar a resolução ou orientar a revisão.
                  </p>
                </div>

                <textarea
                  aria-label="Comentário pedagógico"
                  className="input min-h-[92px] sm:min-h-[110px]"
                  value={editingQuestion.official_explanation}
                  onChange={(event) => updateEditingField('official_explanation', event.target.value)}
                  placeholder="Descreva a resolução comentada ou observações para o professor."
                />
              </section>

              <section className="rounded-2xl border border-neutral-100 bg-white p-3.5 dark:border-white/10 dark:bg-neutral-900/20 sm:p-4">
                <h3 className="mb-3 text-sm font-bold text-neutral-800 dark:text-neutral-100">
                  Configurações da questão
                </h3>
                <div className="mb-4">
                  <label className="label">Espaço para desenvolvimento na prova</label>
                  <select
                    aria-label="Espaço para desenvolvimento na prova"
                    className="input"
                    value={editingQuestion.development_space || 'none'}
                    onChange={(event) => updateEditingField('development_space', event.target.value)}
                  >
                    {developmentSpaceOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs leading-relaxed text-neutral-400">
                    Reserva espaço para o estudante mostrar os cálculos ou explicar como resolveu.
                  </p>
                </div>

                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={editingQuestion.reviewed}
                    onChange={(event) => updateEditingField('reviewed', event.target.checked)}
                    className="w-4 h-4 rounded border-neutral-300 text-primary-500 focus:ring-primary-500"
                  />
                  <span className="text-sm text-neutral-600 dark:text-neutral-300">
                    Marcar questão como revisada
                  </span>
                </label>
              </section>
            </div>


            <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-3 dark:border-white/10"><button type="button" className="btn-outline" onClick={closeEditor}>Cancelar</button><button type="button" className="btn-primary" disabled={savingEdit} onClick={saveEditedQuestion}><Save size={16} />{savingEdit ? 'Salvando…' : editingMode === 'create' ? 'Criar questão' : 'Salvar alterações'}</button></div>
          </fieldset>
        </div>
      </AssessmentDialog>}
      {showDiagnosticModal && (
        <DiagnosticGeneratorModal
          onClose={() => setShowDiagnosticModal(false)}
          onCreated={(id) => navigate(questionSetUrl(id))}
        />
      )}
    </div>
  );
}

function ProfessorQuestionTabs({ activeTab, onBankClick, onAuthorClick }) {
  const tabClass = (selected) => `inline-flex items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm font-bold transition-colors ${
    selected
      ? 'bg-primary-500 text-white shadow-sm shadow-primary-500/20'
      : 'text-neutral-500 hover:bg-white hover:text-neutral-800 dark:text-neutral-300 dark:hover:bg-white/5 dark:hover:text-white'
  }`;

  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl border border-neutral-200 bg-white p-1 dark:border-white/10 dark:bg-[#111E31] sm:w-fit">
      <button type="button" onClick={onBankClick} aria-pressed={activeTab === 'bank'} className={tabClass(activeTab === 'bank')}>
        <FileText size={16} />
        Questões do banco
      </button>
      <button type="button" onClick={onAuthorClick} aria-pressed={activeTab === 'author'} className={tabClass(activeTab === 'author')}>
        <BadgePlus size={16} />
        Minhas questões
      </button>
    </div>
  );
}
