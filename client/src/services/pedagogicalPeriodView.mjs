const count = value => Number.isSafeInteger(value) && value >= 0;
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number(value.slice(0, 4)) >= 1900 && Number(value.slice(0, 4)) <= 9998
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export function periodInputError(start, end) {
  if (!validDay(start) || !validDay(end)) return 'Informe as duas datas válidas.';
  if (start > end) return 'A data final deve ser igual ou posterior à inicial.';
  if ((Date.parse(end) - Date.parse(start)) / 86400000 >= 366) return 'Escolha um período de até 366 dias.';
  return '';
}
export function parsePedagogicalPeriod(data, classId, query) {
  const p = data?.pagination;
  const fail = () => { throw new Error('Não foi possível conferir os resultados deste período.'); };
  if (data?.version !== 'class-period-v1' || data.classId !== classId || data.period?.start !== query.start || data.period?.end !== query.end ||
    periodInputError(data.period?.start, data.period?.end) || data.period?.timeZone !== 'America/Sao_Paulo' || !Number.isFinite(Date.parse(data.generatedAt)) ||
    !p || !count(p.page) || p.page < 1 || p.limit !== 10 || !count(p.total) || !count(p.totalPages) || p.totalPages !== Math.ceil(p.total / p.limit) ||
    p.page !== Math.min(query.page, Math.max(1, p.totalPages)) || !Array.isArray(data.assessments) ||
    data.assessments.length !== Math.max(0, Math.min(p.limit, p.total - (p.page - 1) * p.limit))) fail();
  const ids = new Set();
  for (const item of data.assessments) {
    const o = item?.overview;
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.title !== 'string' || !['open', 'closed'].includes(item.status) ||
      !Number.isFinite(Date.parse(item.openedAt)) || !o || !['participantCount', 'submittedCount', 'pendingCount'].every(key => count(o[key])) ||
      o.submittedCount + o.pendingCount !== o.participantCount || (o.submittedCount === 0 ? o.meanPercentage !== null :
        !Number.isFinite(o.meanPercentage) || o.meanPercentage < 0 || o.meanPercentage > 100)) fail();
    ids.add(item.id);
  }
  return data;
}

export function parsePedagogicalPeriodCopy(data, classId, query) {
  const fail = () => { throw new Error('Não foi possível conferir a planilha deste período.'); };
  if (data?.version !== 'class-period-copy-v1' || data.class?.id !== classId ||
    typeof data.class.name !== 'string' || !data.class.name.trim() || typeof data.class.gradeName !== 'string' ||
    !Number.isSafeInteger(data.class.academicYear) || !['active', 'archived'].includes(data.class.status) ||
    !data.class.institution || !['verified', 'linked', 'pending', 'unavailable'].includes(data.class.institution.status) ||
    ['school', 'municipality'].some(key => data.class.institution[key] != null && typeof data.class.institution[key] !== 'string') ||
    !count(data.total) || !data.total || data.limit !== 200 || data.total > data.limit ||
    typeof data.revision !== 'string' || !/^[a-f0-9]{64}$/.test(data.revision) ||
    typeof data.notice !== 'string' || !data.notice.trim() || typeof data.privacyNotice !== 'string' || !data.privacyNotice.trim() ||
    !Array.isArray(data.assessments) || data.assessments.length !== data.total) fail();
  const ids = new Set();
  for (let offset = 0; offset < data.total; offset += 10) {
    const page = Math.floor(offset / 10) + 1;
    parsePedagogicalPeriod({ ...data, version: 'class-period-v1', classId,
      assessments: data.assessments.slice(offset, offset + 10),
      pagination: { page, limit: 10, total: data.total, totalPages: Math.ceil(data.total / 10) } }, classId, { ...query, page });
  }
  for (const item of data.assessments) {
    if (ids.has(item.id) || !count(item.questionCount) || !item.questionCount || !count(item.overview.exemptedCount)) fail();
    ids.add(item.id);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(item.openedAt)).map(part => [part.type, part.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    if (day < query.start || day > query.end) fail();
  }
  return data;
}
