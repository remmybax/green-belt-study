// Progress and settings, stored only on this device.

const PROGRESS_KEY = 'gb-progress-v1';
const SETTINGS_KEY = 'gb-settings-v1';
const REVIEW_DAYS = [1, 3, 7];
const DAY_MS = 24 * 60 * 60 * 1000;

function emptyProgress() {
  return { focus: {}, question: {}, problem: {}, exams: [] };
}

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? Object.assign(fallback, JSON.parse(raw)) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

const progress = readStore(PROGRESS_KEY, emptyProgress());
const settings = readStore(SETTINGS_KEY, { theme: 'auto', fontScale: 1, lastRoute: null, lastBackup: null, installHintDismissed: false });

function saveProgress() {
  return writeStore(PROGRESS_KEY, progress);
}

function saveSettings() {
  return writeStore(SETTINGS_KEY, settings);
}

// ---------- focus points ----------

function isDone(fid) {
  return !!(progress.focus[fid] && progress.focus[fid].done);
}

function setDone(fid, done) {
  progress.focus[fid] = { done, updated: Date.now() };
  saveProgress();
}

function rollup(scope) {
  const ids = focusIdsIn(scope);
  const done = ids.filter(isDone).length;
  // Floor so a scope never reads 100% until every focus point is checked.
  return { done, total: ids.length, pct: ids.length ? Math.floor((done / ids.length) * 100) : 0 };
}

// ---------- questions ----------

function sameLetters(a, b) {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

// Leitner boxes: a miss goes to box 1 (due in 1 day); each later correct answer moves it up a box
// (3 days, then 7) and a correct answer from box 3 retires it. Never-missed questions stay out.
function recordAnswer(qid, letters, correct) {
  const prev = progress.question[qid] || { attempts: 0, box: null };
  let box;
  if (!correct) box = 1;
  else if (prev.box == null) box = null;
  else box = prev.box >= REVIEW_DAYS.length ? null : prev.box + 1;
  progress.question[qid] = {
    attempts: prev.attempts + 1,
    lastAnswer: [...letters].sort(),
    correct,
    box,
    due: box ? Date.now() + REVIEW_DAYS[box - 1] * DAY_MS : null,
    updated: Date.now(),
  };
  saveProgress();
}

function questionStatus(qid) {
  const s = progress.question[qid];
  if (!s) return null;
  return s.correct ? 'right' : 'wrong';
}

// Share of a focus point's linked questions whose latest answer was correct.
function mastery(fid) {
  const ids = manifest.focus[fid].q;
  return { right: ids.filter((id) => questionStatus(id) === 'right').length, total: ids.length };
}

// ---------- review queue ----------

function dueQuestionIds(now = Date.now()) {
  return Object.entries(progress.question)
    .filter(([, s]) => s.box && s.due <= now)
    .sort((a, b) => a[1].due - b[1].due)
    .map(([id]) => id);
}

function nextReviewTime() {
  const upcoming = Object.values(progress.question).filter((s) => s.box && s.due > Date.now()).map((s) => s.due);
  return upcoming.length ? Math.min(...upcoming) : null;
}

// ---------- practice exams ----------
// The active exam is saved after every change and timed against the wall clock (endsAt),
// so closing the app mid-exam keeps the clock running, as in the real test.

function startExam(def, itemIds) {
  const now = Date.now();
  progress.activeExam = {
    examId: def.id,
    title: def.title,
    passPercent: def.passPercent,
    itemIds: itemIds || null,
    startedAt: now,
    endsAt: now + def.minutes * 60 * 1000,
    answers: {},
    flagged: [],
    current: 0,
  };
  saveProgress();
}

function examTimeLeft() {
  return progress.activeExam ? Math.max(0, progress.activeExam.endsAt - Date.now()) : 0;
}

function setExamAnswer(index, letters) {
  progress.activeExam.answers[index] = letters;
  saveProgress();
}

function toggleExamFlag(index) {
  const flags = progress.activeExam.flagged;
  progress.activeExam.flagged = flags.includes(index) ? flags.filter((i) => i !== index) : [...flags, index];
  saveProgress();
}

function setExamCurrent(index) {
  progress.activeExam.current = index;
  saveProgress();
}

function examAnswered(active) {
  return Object.values(active.answers).filter((a) => a && a.length).length;
}

// Scores the active exam, stores the result in progress.exams and returns its index.
function finishExam(items, timedOut) {
  const a = progress.activeExam;
  const byDomain = {};
  let right = 0;
  items.forEach((item, i) => {
    const d = (byDomain[item.domain] = byDomain[item.domain] || { right: 0, total: 0 });
    d.total++;
    const given = a.answers[i] || [];
    if (given.length && sameLetters(given, item.answer)) {
      right++;
      d.right++;
    }
  });
  progress.exams.push({
    id: a.examId,
    title: a.title,
    itemIds: a.itemIds,
    started: a.startedAt,
    finished: Math.min(Date.now(), a.endsAt),
    timedOut: !!timedOut,
    passPercent: a.passPercent,
    right,
    total: items.length,
    // Floor so a score never rounds up across the pass line.
    score: Math.floor((right / items.length) * 100),
    byDomain,
    answers: a.answers,
    flagged: a.flagged,
  });
  delete progress.activeExam;
  saveProgress();
  return progress.exams.length - 1;
}

function abandonExam() {
  delete progress.activeExam;
  saveProgress();
}

// ---------- workbook problems ----------

function recordReveal(pid) {
  const prev = progress.problem[pid] || { selfGrade: null };
  progress.problem[pid] = { ...prev, revealed: true, updated: Date.now() };
  saveProgress();
}

function recordGrade(pid, grade) {
  progress.problem[pid] = { revealed: true, selfGrade: grade, updated: Date.now() };
  saveProgress();
}

function problemStatus(pid) {
  const s = progress.problem[pid];
  return s ? s.selfGrade : null;
}

// ---------- backup ----------

const BACKUP_APP = 'gb-study';
const BACKUP_FORMAT = 1;

function backupPayload() {
  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    exported: new Date().toISOString(),
    contentVersion: manifest ? manifest.contentVersion : null,
    progress,
  };
}

// Returns { progress, exported } or throws an Error whose message is shown to the reader.
function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('That file is not a backup from this app. Choose a file saved with "Save backup file".');
  }
  if (!data || data.app !== BACKUP_APP || !data.progress) {
    throw new Error('That file is not a backup from this app. Choose a file saved with "Save backup file".');
  }
  if (data.format > BACKUP_FORMAT) {
    throw new Error('That backup was saved by a newer version of the app. Reload to update the app, then try again.');
  }
  const p = data.progress;
  const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isMap(p.focus) || !isMap(p.question) || !isMap(p.problem) || !Array.isArray(p.exams)) {
    throw new Error('That backup file is damaged and cannot be restored.');
  }
  return { progress: p, exported: data.exported || null };
}

function replaceProgress(next) {
  for (const key of Object.keys(progress)) delete progress[key];
  Object.assign(progress, emptyProgress(), next);
  return saveProgress();
}

function resetProgress() {
  return replaceProgress(emptyProgress());
}

function progressSummary(p) {
  const studied = Object.values(p.focus).filter((f) => f && f.done).length;
  const answered = Object.keys(p.question).length;
  const worked = Object.keys(p.problem).length;
  return `${studied} focus points studied, ${answered} questions answered, ${worked} workbook problems tried`;
}

function tally(ids, statusFn) {
  const t = { right: 0, wrong: 0, total: ids.length };
  ids.forEach((id) => {
    const s = statusFn(id);
    if (s === 'right') t.right++;
    else if (s === 'wrong') t.wrong++;
  });
  return t;
}
