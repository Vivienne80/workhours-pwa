import * as db from './db.js';
import * as calc from './calc.js';
import { dateKey, isWeekend, isPublicHoliday, isHoliday, weekdayLabel, KOREAN_HOLIDAYS, WEEKDAY_LABELS } from './holidays.js';

// ─── State ───────────────────────────────────────────
let currentView = 'home';
let calendarDate = new Date();  // year/month shown in calendar
let realtimeTimer = null;
let companyHolidays = {};
let plannedCheckout = null;   // 퇴근 예측 카드 예정 퇴근시각
let selectedCalendarDate = null; // 달력에서 선택한 날짜
let monthlyYear = new Date().getFullYear();
let monthlyMonth = new Date().getMonth() + 1;
let holidaysYear = new Date().getFullYear();
let holidaysTab = 0; // 0: 법정공휴일, 1: 회사휴일

// ─── Boot ─────────────────────────────────────────────
async function boot() {
  companyHolidays = await db.getCompanyHolidays();
  setupNav();
  await renderView(currentView);
  startRealtimeTimer();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'activated') window.location.reload();
        });
      });
    }).catch(() => {});
  }
}

// ─── Navigation ───────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      currentView = btn.dataset.view;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
      await renderView(currentView);
    });
  });
}

async function renderView(view) {
  const main = document.getElementById('app-main');
  const title = document.getElementById('page-title');
  const action = document.getElementById('header-action');
  action.textContent = '';
  action.onclick = null;

  switch (view) {
    case 'home':
      title.textContent = todayTitle();
      await renderHome(main);
      break;
    case 'calendar':
      title.textContent = '달력';
      await renderCalendar(main);
      break;
    case 'holidays':
      title.textContent = '공휴일';
      action.textContent = holidaysTab === 1 ? '+ 추가' : '';
      action.onclick = holidaysTab === 1 ? showAddHoliday : null;
      await renderHolidays(main);
      break;
    case 'monthly':
      title.textContent = '월간 현황';
      await renderMonthly(main);
      break;
    case 'leave':
      title.textContent = '연차';
      await renderLeave(main);
      break;
    case 'settings':
      title.textContent = '설정';
      await renderSettings(main);
      break;
  }
}

function todayTitle() {
  const now = new Date();
  return `${now.getFullYear()}년 ${now.getMonth()+1}월 ${now.getDate()}일 (${weekdayLabel(now)})`;
}

// ─── Realtime timer ───────────────────────────────────
function startRealtimeTimer() {
  if (realtimeTimer) clearInterval(realtimeTimer);
  realtimeTimer = setInterval(async () => {
    if (currentView === 'home') {
      document.getElementById('page-title').textContent = todayTitle();
      await renderHome(document.getElementById('app-main'));
    }
  }, 30000);
}

// ─── HOME ─────────────────────────────────────────────
async function renderHome(main) {
  const now = new Date();
  const today = dateKey(now);
  const defaultType = isHoliday(now) ? 'holiday' : 'normal';
  const rec = await db.getRecord(today) || { date: today, workType: defaultType };
  const monthlyOT = await calcMonthlyOvertimeToYesterday();
  const weekly = await calcWeekly();

  const checkIn = rec.checkIn || null;
  const checkOut = rec.checkOut || null;
  const workType = rec.workType || 'normal';
  const wtInfo = calc.WORK_TYPES[workType] || calc.WORK_TYPES.normal;

  const hasCoreToday = now.getDay() >= 2 && now.getDay() <= 4; // Tue-Thu
  const stdOut = calc.checkoutStandard(checkIn);
  const minOut = calc.checkoutMinimum(checkIn, monthlyOT.diff, hasCoreToday);

  // 퇴근 예측: 출근 후 미퇴근 시 초기화
  if (checkIn && !checkOut) {
    if (!plannedCheckout) plannedCheckout = minOut;
  } else {
    plannedCheckout = null;
  }

  // Realtime work
  const realtimeMin = calcRealtimeOrFinal(rec);

  let html = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span style="font-size:12px;color:var(--text-2)">근무 유형</span>
        <span class="badge" style="background:${wtInfo.color}">${wtInfo.label}</span>
      </div>
      <hr class="divider" style="margin:0 0 12px">
      <div class="time-display">
        <div class="time-col">
          <span class="time-label">출근</span>
          <span class="time-value" style="color:var(--primary)">${checkIn || '--:--'}</span>
        </div>
        <span class="time-arrow">→</span>
        <div class="time-col">
          <span class="time-label">퇴근</span>
          <span class="time-value" style="color:var(--orange)">${checkOut || '--:--'}</span>
        </div>
      </div>`;

  if (checkIn && !checkOut) {
    html += `
      <div class="stat-row" style="margin-top:8px">
        <div class="stat-item">
          <span class="stat-label">현재 근무시간</span>
          <span class="stat-value big" style="color:var(--primary)">${calc.formatTime(realtimeMin)}</span>
        </div>
      </div>
      <hr class="divider">
      <div class="stat-row">
        <div class="stat-item">
          <span class="stat-label">권장 퇴근 (9h)</span>
          <span class="stat-value" style="color:var(--green)">${stdOut || '--:--'}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">최단 퇴근</span>
          <span class="stat-value" style="color:var(--text-2)">${minOut}</span>
        </div>
      </div>`;

  // ── 퇴근 예측 카드 ──
  const planned = plannedCheckout;
  if (planned) {
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const plannedMin = timeToMinutes(planned);
    const remaining = Math.max(0, plannedMin - nowMin);
    const tempRec = { checkIn, checkOut: planned, workType };
    const expectedWork = calc.calcDailyWork(tempRec);
    const neededToday = Math.max(0, 8 * 60 - monthlyOT.diff);
    const overtimeDiff = expectedWork !== null ? expectedWork - neededToday : null;
    html += `
      <div class="card" style="padding:14px 16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span style="font-size:14px;font-weight:700">퇴근 예측</span>
          <button id="btn-planned" style="background:none;border:1.5px solid var(--border);border-radius:8px;padding:4px 12px;font-size:16px;font-weight:700;color:var(--text);cursor:pointer">${planned}</button>
        </div>
        <div class="stat-row">
          <div class="stat-item">
            <span class="stat-label">남은 시간</span>
            <span class="stat-value" style="color:var(--primary)">${calc.formatTime(remaining)}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">예상 실근무</span>
            <span class="stat-value">${expectedWork !== null ? calc.formatTime(expectedWork) : '--:--'}</span>
          </div>
          ${overtimeDiff !== null ? `<div class="stat-item">
            <span class="stat-label">${overtimeDiff < 0 ? '미달' : '초과'}</span>
            <span class="stat-value" style="color:${overtimeDiff < 0 ? 'var(--red)' : 'var(--orange)'}">${overtimeDiff < 0 ? '-' : '+'}${calc.formatTime(Math.abs(overtimeDiff))}</span>
          </div>` : ''}
        </div>
      </div>`;
  }
  } else if (checkIn && checkOut) {
    const worked = calc.calcDailyWork(rec);
    const ot = calc.calcOvertime(rec);
    html += `
      <div class="stat-row" style="margin-top:8px">
        <div class="stat-item">
          <span class="stat-label">실근무시간</span>
          <span class="stat-value big" style="color:var(--primary)">${worked !== null ? calc.formatTime(worked) : '--:--'}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">초과근무</span>
          <span class="stat-value big" style="color:${ot > 0 ? 'var(--orange)' : 'var(--text-2)'}">${calc.formatTime(ot)}</span>
        </div>
      </div>`;
  }

  html += `</div>`;

  // Action buttons
  html += `
    <div class="btn-row">
      <button class="btn btn-checkin" id="btn-checkin" ${checkIn ? 'disabled' : ''}>
        ↪ 출근
      </button>
      <button class="btn btn-checkout" id="btn-checkout" ${(!checkIn || checkOut) ? 'disabled' : ''}>
        ↩ 퇴근
      </button>
    </div>
    <button class="btn btn-secondary" id="btn-edit" style="margin-bottom:10px;height:40px;font-size:14px">
      ✏️ 오늘 기록 수정
    </button>`;

  // Core time card
  const inCore = hasCoreToday && now.getHours() >= 10 && now.getHours() < 14;
  html += `
    <div class="card" style="padding:12px 16px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:13px;font-weight:600">코어타임 🕐</div>
          <div style="font-size:12px;color:var(--text-2)">화·수·목 10:00~14:00 의무 재실</div>
        </div>
        <span style="font-size:13px;font-weight:700;color:${hasCoreToday ? (inCore ? 'var(--green)' : 'var(--orange)') : 'var(--text-2)'}">
          ${hasCoreToday ? (inCore ? '재실 중' : '코어타임 외') : '오늘 없음'}
        </span>
      </div>
    </div>`;

  // Weekly card
  html += `
    <div class="card">
      <div class="card-title">이번주 현황</div>
      <div class="stat-row">
        <div class="stat-item">
          <span class="stat-label">실근무</span>
          <span class="stat-value" style="color:var(--primary)">${calc.formatTime(weekly.worked)}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">필요</span>
          <span class="stat-value" style="color:var(--text-2)">${calc.formatTime(weekly.base)}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">${weekly.diff < 0 ? '부족' : '초과'}</span>
          <span class="stat-value" style="color:${weekly.diff < 0 ? 'var(--red)' : 'var(--green)'}">${calc.formatTime(Math.abs(weekly.diff))}</span>
        </div>
      </div>
      <div class="progress-wrap">
        <div class="progress-bar" style="width:${weekly.base > 0 ? Math.min(100, weekly.worked / weekly.base * 100).toFixed(1) : 0}%;background:${weekly.worked >= weekly.base ? 'var(--primary)' : 'var(--orange)'}"></div>
      </div>
      ${weekly.worked > 52*60 ? '<div class="warn-box">⚠️ 주 52시간 초과!</div>' : ''}
    </div>`;

  // Monthly overtime card
  if (now.getDate() > 1) {
    const { worked: mWorked, base: mBase, diff: mDiff } = monthlyOT;
    html += `
      <div class="card">
        <div class="card-title">${now.getMonth()+1}월 누적 (어제까지)</div>
        <div class="stat-row">
          <div class="stat-item">
            <span class="stat-label">실근무</span>
            <span class="stat-value" style="color:var(--primary)">${calc.formatTime(mWorked)}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">기준</span>
            <span class="stat-value" style="color:var(--text-2)">${calc.formatTime(mBase)}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">${mDiff < 0 ? '미달' : '초과'}</span>
            <span class="stat-value" style="color:${mDiff < 0 ? 'var(--red)' : 'var(--green)'}">${mDiff < 0 ? '-' : '+'}${calc.formatTime(Math.abs(mDiff))}</span>
          </div>
        </div>
      </div>`;
  }

  main.innerHTML = html;

  // Events
  document.getElementById('btn-checkin').onclick = () => checkInOut('in', rec);
  document.getElementById('btn-checkout').onclick = () => checkInOut('out', rec);
  document.getElementById('btn-edit').onclick = () => showRecordEdit(today, rec);
  const btnPlanned = document.getElementById('btn-planned');
  if (btnPlanned) {
    btnPlanned.onclick = () => {
      const picked = promptTime('예정 퇴근 시각을 입력하세요', plannedCheckout || '--:--');
      if (!picked) return;
      plannedCheckout = calc.formatTime(calc.roundTo15(timeToMinutes(picked)));
      renderView('home');
    };
  }
}

function calcRealtimeOrFinal(rec) {
  if (rec.checkIn && rec.checkOut) {
    return calc.calcDailyWork(rec) || 0;
  }
  return calc.calcTodayRealtime(rec.checkIn);
}

async function calcMonthlyOvertimeToYesterday() {
  const now = new Date();
  if (now.getDate() === 1) return { worked: 0, base: 0, diff: 0 };
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const from = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const to = dateKey(yesterday);
  const records = await db.getRecords(from, to);
  const recMap = {};
  records.forEach(r => { recMap[r.date] = r; });

  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  let worked = 0, base = 0;

  for (let i = 0; i < yesterday.getDate(); i++) {
    const day = new Date(firstDay);
    day.setDate(firstDay.getDate() + i);
    if (isHoliday(day)) continue;
    const k = dateKey(day);
    if (companyHolidays[k]) continue;
    const r = recMap[k];
    if (r) {
      worked += calc.calcDailyWork(r) || 0;
      base += calc.baseWorkMinutes(r.workType);
    } else {
      base += 8 * 60;
    }
  }
  return { worked, base, diff: worked - base };
}

async function calcWeekly() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0,0,0,0);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);

  const from = dateKey(monday);
  const to = dateKey(friday);
  const records = await db.getRecords(from, to);
  const recMap = {};
  records.forEach(r => { recMap[r.date] = r; });

  let worked = 0, base = 0;
  for (let i = 0; i < 5; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    if (isHoliday(day)) continue;
    const k = dateKey(day);
    if (companyHolidays[k]) continue;
    const r = recMap[k];
    if (r) {
      base += calc.baseWorkMinutes(r.workType);
      if (day <= now) {
        const todayKey = dateKey(now);
        if (k === todayKey && r.checkIn && !r.checkOut) {
          worked += calc.calcTodayRealtime(r.checkIn);
        } else {
          worked += calc.calcDailyWork(r) || 0;
        }
      }
    } else {
      base += 8 * 60;
    }
  }
  return { worked, base, diff: worked - base };
}

async function checkInOut(type, rec) {
  const now = new Date();
  const defaultTime = calc.currentTime15();
  const picked = promptTime(`${type === 'in' ? '출근' : '퇴근'} 시각을 입력하세요`, defaultTime);
  if (!picked) return;

  const rounded = calc.formatTime(calc.roundTo15(timeToMinutes(picked)));
  const today = dateKey(now);
  const updated = { date: today, workType: rec.workType || 'normal', ...rec };
  if (type === 'in') updated.checkIn = rounded;
  else updated.checkOut = rounded;

  await db.saveRecord(updated);
  await renderView('home');
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function promptTime(msg, defaultVal) {
  return window.prompt(msg, defaultVal);
}

// ─── Record Edit Modal ─────────────────────────────────
function showRecordEdit(date, rec) {
  const d = new Date(date + 'T00:00:00');
  const title = `${d.getMonth()+1}/${d.getDate()} (${weekdayLabel(d)}) 수정`;
  const workType = rec.workType || 'normal';
  const isLeaveType = (wt) => wt === 'annualLeave' || wt === 'holiday';

  const wtBtns = Object.entries(calc.WORK_TYPES).map(([k,v]) =>
    `<button class="wt-btn ${k === workType ? 'selected' : ''}" data-wt="${k}">${v.label}</button>`
  ).join('');

  const tripDest = rec.tripDestination || '';
  const hideTime = isLeaveType(workType);

  const modalHtml = `
    <button class="modal-close" id="modal-close">✕</button>
    <div class="modal-title">${title}</div>

    <div class="form-group">
      <label class="form-label">근무 유형</label>
      <div class="wt-select" id="wt-select">${wtBtns}</div>
    </div>
    <div id="time-group" ${hideTime ? 'style="display:none"' : ''}>
      <div class="form-group">
        <label class="form-label">출근</label>
        <input class="form-input" type="time" id="edit-checkin" value="${rec.checkIn || ''}">
      </div>
      <div class="form-group">
        <label class="form-label">퇴근</label>
        <input class="form-input" type="time" id="edit-checkout" value="${rec.checkOut || ''}">
      </div>
      <div id="calc-preview" style="display:none;background:var(--primary-light);border-radius:8px;padding:10px 14px;margin-bottom:14px">
        <div class="stat-row">
          <div class="stat-item">
            <span class="stat-label">실근무</span>
            <span id="preview-worked" class="stat-value" style="font-size:18px;color:var(--primary)">--:--</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">초과</span>
            <span id="preview-ot" class="stat-value" style="font-size:18px;color:var(--orange)">--:--</span>
          </div>
        </div>
      </div>
    </div>
    <div class="form-group" id="trip-group" ${workType !== 'businessTrip' ? 'style="display:none"' : ''}>
      <label class="form-label">출장지</label>
      <input class="form-input" type="text" id="edit-trip" value="${tripDest}" placeholder="출장지 입력">
    </div>
    <div class="form-group">
      <label class="form-label">메모</label>
      <input class="form-input" type="text" id="edit-memo" value="${rec.memo || ''}" placeholder="(선택)">
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" id="edit-save">저장</button>
      <button class="btn btn-danger" id="edit-delete">삭제</button>
    </div>`;

  openModal(modalHtml);

  function updateCalcPreview() {
    const ci = document.getElementById('edit-checkin')?.value;
    const co = document.getElementById('edit-checkout')?.value;
    const preview = document.getElementById('calc-preview');
    if (!ci || !co || !preview) return;
    const tempRec = { checkIn: ci, checkOut: co, workType: selectedWt };
    const worked = calc.calcDailyWork(tempRec);
    const ot = worked !== null ? Math.max(0, worked - calc.baseWorkMinutes(selectedWt)) : 0;
    if (worked !== null) {
      preview.style.display = '';
      document.getElementById('preview-worked').textContent = calc.formatTime(worked);
      document.getElementById('preview-ot').textContent = calc.formatTime(ot);
      document.getElementById('preview-ot').style.color = ot > 0 ? 'var(--orange)' : 'var(--text-2)';
    } else {
      preview.style.display = 'none';
    }
  }

  let selectedWt = workType;
  document.querySelectorAll('#wt-select .wt-btn').forEach(btn => {
    btn.onclick = () => {
      selectedWt = btn.dataset.wt;
      document.querySelectorAll('#wt-select .wt-btn').forEach(b => b.classList.toggle('selected', b === btn));
      const timeGroup = document.getElementById('time-group');
      if (timeGroup) timeGroup.style.display = isLeaveType(selectedWt) ? 'none' : '';
      const tripGroup = document.getElementById('trip-group');
      if (tripGroup) tripGroup.style.display = selectedWt === 'businessTrip' ? '' : 'none';
      updateCalcPreview();
    };
  });

  document.getElementById('edit-checkin')?.addEventListener('change', updateCalcPreview);
  document.getElementById('edit-checkout')?.addEventListener('change', updateCalcPreview);
  updateCalcPreview();

  document.getElementById('edit-save').onclick = async () => {
    const ci = document.getElementById('edit-checkin')?.value;
    const co = document.getElementById('edit-checkout')?.value;
    const memo = document.getElementById('edit-memo').value;
    const tripDestVal = document.getElementById('edit-trip')?.value || '';

    const leave = isLeaveType(selectedWt);
    const roundedCi = (!leave && ci) ? calc.formatTime(calc.roundTo15(timeToMinutes(ci))) : null;
    const roundedCo = (!leave && co) ? calc.formatTime(calc.roundTo15(timeToMinutes(co))) : null;

    await db.saveRecord({
      date,
      workType: selectedWt,
      checkIn: roundedCi || null,
      checkOut: roundedCo || null,
      tripDestination: selectedWt === 'businessTrip' ? (tripDestVal || null) : null,
      memo: memo || null,
    });
    closeModal();
    companyHolidays = await db.getCompanyHolidays();
    await renderView(currentView);
  };

  document.getElementById('edit-delete').onclick = async () => {
    if (!confirm('이 날짜의 기록을 삭제할까요?')) return;
    await db.deleteRecord(date);
    closeModal();
    await renderView(currentView);
  };
}

// ─── CALENDAR ─────────────────────────────────────────
async function renderCalendar(main) {
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();

  const from = `${year}-${String(month+1).padStart(2,'0')}-01`;
  const lastDay = new Date(year, month+1, 0).getDate();
  const to = `${year}-${String(month+1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  const records = await db.getRecords(from, to);
  const recMap = {};
  records.forEach(r => { recMap[r.date] = r; });

  const firstDow = new Date(year, month, 1).getDay(); // 0=Sun
  const emptyCells = firstDow === 0 ? 6 : firstDow - 1; // Mon-start grid

  let html = `
    <div class="cal-nav">
      <button id="cal-prev">‹</button>
      <span class="cal-month">${year}년 ${month+1}월</span>
      <button id="cal-next">›</button>
    </div>
    <div class="cal-grid">
      ${WEEKDAY_LABELS.map((d,i) => `<div class="cal-header-cell ${i===5?'sat':i===6?'sun':''}">${d}</div>`).join('')}`;

  for (let e = 0; e < emptyCells; e++) html += `<div class="cal-cell empty"></div>`;

  const todayKey = dateKey(new Date());

  for (let d = 1; d <= lastDay; d++) {
    const date = new Date(year, month, d);
    const k = dateKey(date);
    const dow = date.getDay(); // 0=Sun,6=Sat
    const isSat = dow === 6;
    const isSun = dow === 0;
    const isPubHoli = isPublicHoliday(date);
    const isCompHoli = !!companyHolidays[k];
    const rec = recMap[k];
    const isToday = k === todayKey;

    let dayClass = isPubHoli || isSun ? 'sun' : isSat ? 'sat' : '';
    let cellClass = isToday ? 'today' : '';
    if (isPubHoli || isSun) cellClass += ' holiday-bg';
    else if (isCompHoli) cellClass += ' company-holiday-bg';

    let timesHtml = '';
    if (rec) {
      if (rec.checkIn) timesHtml += `<div class="cal-time ci">▶ ${rec.checkIn}</div>`;
      if (rec.checkOut) timesHtml += `<div class="cal-time co">■ ${rec.checkOut}</div>`;
      const wt = calc.WORK_TYPES[rec.workType];
      if (wt && rec.workType !== 'normal') {
        timesHtml += `<div class="cal-wt" style="color:${wt.color}">${wt.label}</div>`;
      }
    }

    const pubHoliName = KOREAN_HOLIDAYS[k];
    const compHoliName = companyHolidays[k];
    let holiNameHtml = '';
    if (pubHoliName) holiNameHtml = `<div class="cal-holi">${pubHoliName}</div>`;
    else if (compHoliName) holiNameHtml = `<div class="cal-holi" style="color:var(--green)">${compHoliName}</div>`;

    html += `
      <div class="cal-cell ${cellClass}" data-date="${k}">
        <div class="cal-day ${dayClass}">${d}</div>
        ${holiNameHtml}
        <div class="cal-times">${timesHtml}</div>
      </div>`;
  }

  html += `</div><div id="cal-detail-panel"></div>`;
  main.innerHTML = html;

  document.getElementById('cal-prev').onclick = async () => {
    calendarDate.setMonth(calendarDate.getMonth() - 1);
    selectedCalendarDate = null;
    await renderCalendar(main);
  };
  document.getElementById('cal-next').onclick = async () => {
    calendarDate.setMonth(calendarDate.getMonth() + 1);
    selectedCalendarDate = null;
    await renderCalendar(main);
  };

  function renderCalDetail(k) {
    selectedCalendarDate = k;
    main.querySelectorAll('.cal-cell[data-date]').forEach(c =>
      c.style.outline = c.dataset.date === k ? '2px solid var(--primary)' : '');
    const panel = document.getElementById('cal-detail-panel');
    if (!panel) return;
    const r = recMap[k];
    const cellDate = new Date(k + 'T00:00:00');
    const pubHoli = KOREAN_HOLIDAYS[k];
    const compHoli = companyHolidays[k];

    let pHtml = `<div class="card" style="margin-top:8px">`;

    if (pubHoli) {
      pHtml += `<div style="font-size:12px;color:#c62828;margin-bottom:8px">📅 ${pubHoli}</div>`;
    }
    if (compHoli) {
      pHtml += `<div style="font-size:12px;color:var(--green);margin-bottom:8px">🏢 회사 휴일 · ${compHoli}</div>`;
    }

    if (!r) {
      pHtml += `<div style="color:var(--text-2);font-size:13px;text-align:center;padding:8px 0">기록 없음${isHoliday(cellDate) ? ' (휴일)' : ''}</div>`;
    } else {
      const wt = calc.WORK_TYPES[r.workType] || calc.WORK_TYPES.normal;
      pHtml += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span class="badge" style="background:${wt.color}">${wt.label}</span>
        ${r.tripDestination ? `<span style="font-size:13px;color:var(--text-2)">· ${r.tripDestination}</span>` : ''}
      </div>`;
      if (r.checkIn || r.checkOut) {
        pHtml += `<div class="stat-row" style="justify-content:flex-start;gap:24px;margin-bottom:8px">
          <div class="stat-item">
            <span class="stat-label">출근</span>
            <span class="stat-value" style="font-size:18px;color:var(--primary)">${r.checkIn || '--:--'}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">퇴근</span>
            <span class="stat-value" style="font-size:18px;color:var(--orange)">${r.checkOut || '--:--'}</span>
          </div>`;
        const worked = calc.calcDailyWork(r);
        const ot = calc.calcOvertime(r);
        if (worked !== null) {
          pHtml += `<div class="stat-item">
            <span class="stat-label">실근무</span>
            <span class="stat-value" style="font-size:18px">${calc.formatTime(worked)}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">초과</span>
            <span class="stat-value" style="font-size:18px;color:${ot > 0 ? 'var(--orange)' : 'var(--text-2)'}">${calc.formatTime(ot)}</span>
          </div>`;
        }
        pHtml += `</div>`;
      }
      if (r.memo) {
        pHtml += `<div style="font-size:13px;color:var(--text-2)">메모: ${r.memo}</div>`;
      }
    }

    pHtml += `<button class="btn btn-secondary" id="cal-detail-edit" style="margin-top:10px;height:38px;font-size:13px">✏️ 편집</button>`;
    pHtml += `</div>`;
    panel.innerHTML = pHtml;

    document.getElementById('cal-detail-edit').onclick = () => {
      const cellDate2 = new Date(k + 'T00:00:00');
      const cellDefault = isHoliday(cellDate2) ? 'holiday' : 'normal';
      showRecordEdit(k, recMap[k] || { date: k, workType: cellDefault });
    };
  }

  if (selectedCalendarDate && recMap[selectedCalendarDate] !== undefined) {
    renderCalDetail(selectedCalendarDate);
  } else if (selectedCalendarDate) {
    renderCalDetail(selectedCalendarDate);
  }

  main.querySelectorAll('.cal-cell[data-date]').forEach(cell => {
    cell.onclick = () => renderCalDetail(cell.dataset.date);
  });
}

// ─── HOLIDAYS ─────────────────────────────────────────
function _holiLeadBox(dateStr, isPast, isCompany) {
  const d = new Date(dateStr + 'T00:00:00');
  const wd = d.getDay();
  const wdColor = wd===6?'#1976d2':(wd===0?'#c62828':'var(--text-2)');
  const bg = isPast ? 'var(--border)' : (isCompany ? '#f3e5f5' : '#fff0f0');
  const numColor = isPast ? 'var(--text-2)' : (isCompany ? '#7b1fa2' : '#c62828');
  return `<div style="width:44px;height:44px;background:${bg};border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0">
    <span style="font-size:12px;font-weight:700;color:${numColor}">${d.getMonth()+1}/${d.getDate()}</span>
    <span style="font-size:10px;color:${wdColor}">${weekdayLabel(d)}</span>
  </div>`;
}

async function renderHolidays(main) {
  const todayStr = dateKey(new Date());

  let html = `<div class="holi-tabs">
    <button class="holi-tab-btn ${holidaysTab===0?'active':''}" data-tab="0">법정 공휴일</button>
    <button class="holi-tab-btn ${holidaysTab===1?'active':''}" data-tab="1">회사 휴일</button>
  </div>`;

  if (holidaysTab === 0) {
    const yearItems = Object.entries(KOREAN_HOLIDAYS)
      .filter(([k]) => k.startsWith(`${holidaysYear}-`))
      .sort((a,b) => a[0].localeCompare(b[0]));

    html += `<div class="card" style="margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <select id="holi-year-sel" style="height:32px;border:1.5px solid var(--border);border-radius:8px;padding:0 8px;background:var(--bg);color:var(--text);font-size:14px">
          ${[2022,2023,2024,2025,2026,2027,2028,2029,2030].map(y=>`<option value="${y}"${y===holidaysYear?' selected':''}>${y}년</option>`).join('')}
        </select>
        <span style="margin-left:auto;font-size:13px;font-weight:600;color:#c62828">법정 공휴일 ${yearItems.length}일</span>
      </div>
    </div>`;

    html += `<div class="card">`;
    yearItems.forEach(([dateStr, name]) => {
      const isPast = dateStr < todayStr;
      const isToday = dateStr === todayStr;
      const diff = Math.round((new Date(dateStr+'T00:00:00') - new Date(todayStr+'T00:00:00')) / 86400000);
      const dTag = isToday ? `<span style="font-size:12px;color:var(--primary);font-weight:600">오늘</span>`
        : (!isPast ? `<span style="font-size:12px;color:#c62828;font-weight:500">D-${diff}</span>` : '');
      html += `<div class="holi-item" style="opacity:${isPast?'0.5':'1'}">
        <div style="display:flex;align-items:center;gap:12px">
          ${_holiLeadBox(dateStr, isPast, false)}
          <span style="font-size:14px">${name}</span>
        </div>
        ${dTag}
      </div>`;
    });
    html += `</div>`;
  } else {
    const holidays = await db.getCompanyHolidays();
    const sorted = Object.entries(holidays).sort((a,b) => a[0].localeCompare(b[0]));

    html += `<div class="card">`;
    if (sorted.length === 0) {
      html += `<div style="color:var(--text-2);text-align:center;padding:24px 0">
        <div style="font-size:32px;margin-bottom:8px">🏢</div>
        <div>등록된 회사 휴일이 없습니다</div>
        <div style="font-size:12px;margin-top:4px">+ 추가 버튼으로 추가하세요</div>
      </div>`;
    } else {
      sorted.forEach(([dateStr, name]) => {
        const isPast = dateStr < todayStr;
        const isToday = dateStr === todayStr;
        const diff = Math.round((new Date(dateStr+'T00:00:00') - new Date(todayStr+'T00:00:00')) / 86400000);
        const dTag = isToday ? `<span style="font-size:12px;color:var(--primary);font-weight:600">오늘</span>`
          : (!isPast ? `<span style="font-size:12px;color:#7b1fa2;font-weight:500">D-${diff}</span>` : '');
        html += `<div class="holi-item" style="opacity:${isPast?'0.5':'1'}">
          <div style="display:flex;align-items:center;gap:12px">
            ${_holiLeadBox(dateStr, isPast, true)}
            <span style="font-size:14px">${name}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            ${dTag}
            <button class="holi-del" data-date="${dateStr}">✕</button>
          </div>
        </div>`;
      });
    }
    html += `</div>`;
  }

  main.innerHTML = html;

  main.querySelectorAll('.holi-tab-btn').forEach(btn => {
    btn.onclick = () => {
      holidaysTab = parseInt(btn.dataset.tab);
      const action = document.getElementById('header-action');
      action.textContent = holidaysTab === 1 ? '+ 추가' : '';
      action.onclick = holidaysTab === 1 ? showAddHoliday : null;
      renderHolidays(main);
    };
  });

  const yearSel = main.querySelector('#holi-year-sel');
  if (yearSel) {
    yearSel.onchange = () => { holidaysYear = parseInt(yearSel.value); renderHolidays(main); };
  }

  main.querySelectorAll('.holi-del').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('이 휴일을 삭제할까요?')) return;
      await db.deleteCompanyHoliday(btn.dataset.date);
      companyHolidays = await db.getCompanyHolidays();
      await renderHolidays(main);
    };
  });
}

async function showAddHoliday() {
  const today = dateKey(new Date());
  const modalHtml = `
    <button class="modal-close" id="modal-close">✕</button>
    <div class="modal-title">회사 휴일 추가</div>
    <div class="form-group">
      <label class="form-label">날짜</label>
      <input class="form-input" type="date" id="holi-date" value="${today}">
    </div>
    <div class="form-group">
      <label class="form-label">이름</label>
      <input class="form-input" type="text" id="holi-name" placeholder="예: 창립기념일">
    </div>
    <button class="btn btn-primary" id="holi-save" style="width:100%">추가</button>`;

  openModal(modalHtml);

  document.getElementById('holi-save').onclick = async () => {
    const date = document.getElementById('holi-date').value;
    const name = document.getElementById('holi-name').value.trim();
    if (!date || !name) { alert('날짜와 이름을 모두 입력하세요'); return; }
    await db.saveCompanyHoliday(date, name);
    companyHolidays = await db.getCompanyHolidays();
    closeModal();
    await renderHolidays(document.getElementById('app-main'));
  };
}

// ─── MONTHLY ──────────────────────────────────────────
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

async function renderMonthly(main) {
  const from = `${monthlyYear}-${String(monthlyMonth).padStart(2,'0')}-01`;
  const lastDay = new Date(monthlyYear, monthlyMonth, 0).getDate();
  const to = `${monthlyYear}-${String(monthlyMonth).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  const records = await db.getRecords(from, to);

  // 이번달 집계
  let totalWork = 0, totalBase = 0, workDays = 0;
  const weekMap = {};

  // 오늘 미퇴근 실시간 근무 반영
  const now = new Date();
  const todayKey = dateKey(now);

  records.forEach(r => {
    const wt = r.workType;
    if (wt === 'annualLeave' || wt === 'holiday') return;
    const base = calc.baseWorkMinutes(wt);
    let w = 0;
    if (r.date === todayKey && r.checkIn && !r.checkOut) {
      w = calc.calcTodayRealtime(r.checkIn);
    } else {
      w = calc.calcDailyWork(r) || 0;
    }
    totalWork += w;
    totalBase += base;
    if (w > 0) workDays++;

    // 주별 집계
    const d = new Date(r.date + 'T00:00:00');
    const wn = isoWeek(d);
    if (!weekMap[wn]) weekMap[wn] = { work: 0, base: 0 };
    weekMap[wn].work += w;
    weekMap[wn].base += base;
  });

  const totalDiff = totalWork - totalBase;

  // 연차 (회계연도 기준)
  const totalLeaveStr = await db.getSetting('total_annual_leave') || '18';
  const totalLeave = parseFloat(totalLeaveStr);
  const fy = monthlyMonth >= 3 ? monthlyYear : monthlyYear - 1;
  const fyRecords = await db.getRecords(`${fy}-03-01`, `${fy+1}-02-29`);
  let fyUsed = 0, fyAnnual = 0, fyHalf = 0, fyQuarter = 0;
  fyRecords.forEach(r => {
    if (r.workType === 'annualLeave') { fyUsed += 1; fyAnnual++; }
    else if (r.workType === 'halfDay') { fyUsed += 0.5; fyHalf++; }
    else if (r.workType === 'quarterDay') { fyUsed += 0.25; fyQuarter++; }
    else if (r.workType === 'doubleQuarterDay') { fyUsed += 0.5; fyQuarter++; }
  });
  const fyRemaining = totalLeave - fyUsed;

  // 월 내보내기
  function exportMonth() {
    if (records.length === 0) { alert('내보낼 데이터가 없습니다'); return; }
    const sortedRecs = [...records].sort((a,b) => a.date.localeCompare(b.date));
    const header = '날짜,근무유형,출근,퇴근,실근무시간,초과근무,메모';
    const rows = sortedRecs.map(r => {
      const wt = calc.WORK_TYPES[r.workType]?.label || r.workType;
      const worked = calc.calcDailyWork(r);
      const ot = calc.calcOvertime(r);
      return [r.date, wt, r.checkIn||'', r.checkOut||'',
        worked !== null ? calc.formatTime(worked) : '', calc.formatTime(ot),
        r.tripDestination || r.memo || ''].join(',');
    });
    const csv = '﻿' + [header, ...rows].join('\n');
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workhours_${monthlyYear}${String(monthlyMonth).padStart(2,'0')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 주별 표
  const weekEntries = Object.entries(weekMap).sort((a,b) => Number(a[0]) - Number(b[0]));

  let html = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:4px">
        <button id="mon-prev" style="background:none;border:none;font-size:22px;color:var(--primary);cursor:pointer;padding:4px 6px">‹</button>
        <span style="font-size:17px;font-weight:700">${monthlyYear}년 ${monthlyMonth}월</span>
        <button id="mon-next" style="background:none;border:none;font-size:22px;color:var(--primary);cursor:pointer;padding:4px 6px">›</button>
      </div>
      <button id="mon-export" style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:12px;color:var(--text-2);cursor:pointer">CSV</button>
    </div>

    <div class="card">
      <div class="card-title">근무 현황</div>
      <div class="stat-row">
        <div class="stat-item">
          <span class="stat-label">근무일</span>
          <span class="stat-value big">${workDays}일</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">실근무</span>
          <span class="stat-value big" style="color:var(--primary)">${calc.formatTime(totalWork)}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">${totalDiff < 0 ? '미달' : '초과근무'}</span>
          <span class="stat-value big" style="color:${totalDiff < 0 ? 'var(--red)' : 'var(--orange)'}">${totalDiff < 0 ? '-' : '+'}${calc.formatTime(Math.abs(totalDiff))}</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">${fy}년 연차 현황 (${fy}.03~${fy+1}.02)</div>
      <div class="stat-row">
        <div class="stat-item">
          <span class="stat-label">총 연차</span>
          <span class="stat-value big">${totalLeave}일</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">사용</span>
          <span class="stat-value big" style="color:var(--orange)">${fyUsed}일</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">잔여</span>
          <span class="stat-value big" style="color:${fyRemaining <= 5 ? 'var(--red)' : 'var(--green)'}">${fyRemaining}일</span>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-2);text-align:center;margin-top:6px">연차 ${fyAnnual}일 + 반차 ${fyHalf}회(${fyHalf*0.5}일) + 반반차 ${fyQuarter}회</div>
      <div class="progress-wrap">
        <div class="progress-bar" style="width:${Math.min(100, fyUsed/totalLeave*100).toFixed(1)}%;background:${fyRemaining <= 5 ? 'var(--red)' : 'var(--green)'}"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">주별 근무시간</div>`;

  if (weekEntries.length === 0) {
    html += `<div style="color:var(--text-2);text-align:center;padding:12px 0">데이터 없음</div>`;
  } else {
    weekEntries.forEach(([wn, {work, base}]) => {
      const over52 = work > 52 * 60;
      const pct = base > 0 ? Math.min(150, work / base * 100).toFixed(1) : 0;
      const diff = work - base;
      const barColor = over52 ? 'var(--red)' : work >= base ? 'var(--primary)' : 'var(--orange)';
      html += `
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px${over52 ? ';background:rgba(198,40,40,0.07);border-radius:6px;padding:4px' : ''}">
          ${over52 ? '<span style="font-size:12px">⚠️</span>' : ''}
          <span style="font-size:13px;width:44px;color:${over52 ? 'var(--red)' : 'var(--text)'};font-weight:${over52?'700':'400'}">${wn}주차</span>
          <div style="flex:1;background:var(--border);border-radius:4px;height:12px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${barColor};border-radius:4px"></div>
          </div>
          <span style="font-size:13px;width:50px;text-align:right;color:${over52?'var(--red)':'var(--text)'};font-weight:${over52?'700':'400'}">${calc.formatTime(work)}</span>
          <span style="font-size:11px;width:52px;text-align:right;color:${diff<0?'var(--red)':'var(--green)'}">${diff<0?'':'+'}${calc.formatTime(diff)}</span>
        </div>`;
    });
  }

  html += `</div>`;
  main.innerHTML = html;

  document.getElementById('mon-prev').onclick = async () => {
    if (monthlyMonth === 1) { monthlyMonth = 12; monthlyYear--; }
    else monthlyMonth--;
    await renderMonthly(main);
  };
  document.getElementById('mon-next').onclick = async () => {
    if (monthlyMonth === 12) { monthlyMonth = 1; monthlyYear++; }
    else monthlyMonth++;
    await renderMonthly(main);
  };
  document.getElementById('mon-export').onclick = exportMonth;
}

// ─── LEAVE ────────────────────────────────────────────
let leaveYear = (() => {
  const now = new Date();
  return now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1; // 3월(idx=2) 이상이면 올해
})();

async function renderLeave(main) {
  const totalStr = await db.getSetting('total_annual_leave') || '18';
  const total = parseFloat(totalStr);

  // 연차연도: leaveYear.3.1 ~ (leaveYear+1).2.28(29)
  const from = `${leaveYear}-03-01`;
  const to = `${leaveYear+1}-02-29`; // getRecords는 범위 초과해도 DB에서 필터
  const records = await db.getRecords(from, to);

  const leaveTypes = ['annualLeave', 'halfDay', 'quarterDay', 'doubleQuarterDay'];
  const leaveRecords = records.filter(r => leaveTypes.includes(r.workType));
  leaveRecords.sort((a, b) => b.date.localeCompare(a.date));

  let used = 0, annualCount = 0, halfCount = 0, quarterCount = 0;
  leaveRecords.forEach(r => {
    if (r.workType === 'annualLeave') { used += 1; annualCount++; }
    else if (r.workType === 'halfDay') { used += 0.5; halfCount++; }
    else if (r.workType === 'quarterDay') { used += 0.25; quarterCount++; }
    else if (r.workType === 'doubleQuarterDay') { used += 0.5; quarterCount++; }
  });

  const remaining = total - used;
  const pct = total > 0 ? Math.min(100, used / total * 100).toFixed(1) : 0;
  const usedStr = used % 1 === 0 ? `${used}일` : `${used}일`;
  const remStr = remaining % 1 === 0 ? `${remaining}일` : `${remaining}일`;

  // 연도 선택 옵션 (최근 5개 연차연도)
  const nowYear = new Date().getFullYear();
  const baseYear = new Date().getMonth() >= 2 ? nowYear : nowYear - 1;
  const yearOptions = Array.from({length: 5}, (_, i) => baseYear - i)
    .map(y => `<option value="${y}" ${y === leaveYear ? 'selected' : ''}>${y}년 (${y}.3~${y+1}.2)</option>`)
    .join('');

  let html = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span style="font-size:13px;font-weight:600;color:var(--text-2)">연차 현황</span>
        <select id="leave-year-sel" style="border:1px solid var(--border);border-radius:6px;padding:3px 6px;font-size:12px;background:var(--bg);color:var(--text)">${yearOptions}</select>
      </div>
      <div class="stat-row">
        <div class="stat-item">
          <span class="stat-label">총 연차</span>
          <span class="stat-value big">${total}일</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">사용</span>
          <span class="stat-value big" style="color:var(--orange)">${usedStr}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">잔여</span>
          <span class="stat-value big" style="color:${remaining < 0 ? 'var(--red)' : 'var(--green)'}">${remStr}</span>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-2);text-align:center;margin-top:6px">연차 ${annualCount} + 반차 ${halfCount} + 반반차 ${quarterCount}</div>
      <div class="progress-wrap">
        <div class="progress-bar" style="width:${pct}%;background:var(--orange)"></div>
      </div>
    </div>`;

  if (leaveRecords.length === 0) {
    html += `<div class="card"><div style="color:var(--text-2);text-align:center;padding:20px 0">연차/반차 기록이 없습니다</div></div>`;
  } else {
    html += `<div class="card">`;
    leaveRecords.forEach(r => {
      const d = new Date(r.date + 'T00:00:00');
      const label = `${r.date} (${weekdayLabel(d)})`;
      const wt = calc.WORK_TYPES[r.workType];
      const days = r.workType === 'annualLeave' ? 1 : r.workType === 'halfDay' ? 0.5 : r.workType === 'quarterDay' ? 0.25 : 0.5;
      html += `
        <div class="holi-item">
          <div>
            <div class="holi-date">${label}</div>
            <div class="holi-name" style="color:${wt.color}">${wt.label} (${days}일)</div>
          </div>
        </div>`;
    });
    html += `</div>`;
  }

  main.innerHTML = html;

  document.getElementById('leave-year-sel').onchange = async (e) => {
    leaveYear = parseInt(e.target.value);
    await renderLeave(main);
  };
}

// ─── SETTINGS ─────────────────────────────────────────
async function renderSettings(main) {
  const totalLeave = await db.getSetting('total_annual_leave') || '18';

  main.innerHTML = `
    <div class="card">
      <div class="settings-item">
        <span class="settings-label">총 연차 일수</span>
        <input class="settings-input" type="number" id="set-leave" value="${totalLeave}" min="1" max="99">
      </div>
    </div>
    <div class="card">
      <div class="settings-item">
        <span class="settings-label">CSV 내보내기</span>
        <button class="btn btn-secondary" id="btn-export" style="flex:none;width:auto;padding:0 16px;height:36px;font-size:13px">내보내기</button>
      </div>
      <div class="settings-item" style="border-top:none;padding-top:0">
        <span class="settings-label">CSV 가져오기</span>
        <button class="btn btn-secondary" id="btn-import" style="flex:none;width:auto;padding:0 16px;height:36px;font-size:13px">가져오기</button>
        <input type="file" id="import-file-input" accept=".csv" style="display:none">
      </div>
    </div>`;

  document.getElementById('set-leave').onchange = async (e) => {
    await db.setSetting('total_annual_leave', e.target.value);
  };

  const rulesHtml = `
    <div class="card">
      <div class="card-title" style="margin-bottom:8px">근무 규정</div>
      ${[
        ['기준 근무시간','8시간/일'],
        ['점심 시간','11:50~12:50, 1시간 자동 차감\n(반차·휴일근무 제외)'],
        ['코어타임','화·수·목 10:00~14:00 의무 재실'],
        ['출퇴근 단위','15분 단위'],
        ['초과근무','실근무 − 8시간\n(휴일근무는 전부 초과)'],
      ].map(([label, value]) => `
        <div style="display:flex;padding:7px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:13px;color:var(--text-2);width:110px;flex-shrink:0">${label}</span>
          <span style="font-size:13px;white-space:pre-line">${value}</span>
        </div>`).join('')}
    </div>
    <div class="card">
      <div class="card-title" style="margin-bottom:4px">앱 정보</div>
      <div style="font-size:13px;color:var(--text-2)">근무시간 관리 PWA</div>
      <div style="font-size:12px;color:var(--text-2);margin-top:2px">데이터는 브라우저 IndexedDB에 저장됩니다</div>
    </div>`;

  main.insertAdjacentHTML('beforeend', rulesHtml);

  document.getElementById('btn-export').onclick = exportCSV;
  document.getElementById('btn-import').onclick = () => document.getElementById('import-file-input').click();
  document.getElementById('import-file-input').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const result = await importCSV(file);
    alert(`가져오기 완료\n성공: ${result.imported}건\n건너뜀: ${result.skipped}건\n실패: ${result.failed}건`);
    e.target.value = '';
  };
}

async function exportCSV() {
  const records = await db.getAllRecords();
  if (records.length === 0) { alert('내보낼 데이터가 없습니다'); return; }

  records.sort((a,b) => a.date.localeCompare(b.date));

  const header = '날짜,근무유형,출근,퇴근,실근무시간,초과근무,메모';
  const rows = records.map(r => {
    const wt = calc.WORK_TYPES[r.workType]?.label || r.workType;
    const worked = calc.calcDailyWork(r);
    const ot = calc.calcOvertime(r);
    return [
      r.date, wt,
      r.checkIn || '',
      r.checkOut || '',
      worked !== null ? calc.formatTime(worked) : '',
      calc.formatTime(ot),
      r.tripDestination || r.memo || '',
    ].join(',');
  });

  const csv = '﻿' + [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `workhours_${dateKey(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importCSV(file) {
  const text = await file.text();
  const content = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { imported: 0, skipped: 0, failed: 0 };

  const header = parseCsvRow(lines[0]);
  const dateIdx = header.findIndex(h => h.includes('날짜'));
  const typeIdx = header.findIndex(h => h.includes('유형'));
  const inIdx   = header.findIndex(h => h.includes('출근'));
  const outIdx  = header.findIndex(h => h.includes('퇴근'));
  const memoIdx = header.findIndex(h => h.includes('메모') || h.includes('목적지'));
  if (dateIdx < 0) return { imported: 0, skipped: 0, failed: 0 };

  const wtMap = {
    '정상근무':'normal','근무일':'normal',
    '출장':'businessTrip',
    '재택':'remote','재택근무':'remote',
    '반차':'halfDay',
    '반반차':'quarterDay',
    '반반차×2':'doubleQuarterDay',
    '연차':'annualLeave',
    '휴일근무':'holidayWork',
    '휴일':'holiday',
  };

  let imported = 0, skipped = 0, failed = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    if (cols.length <= dateIdx) continue;
    const date = cols[dateIdx].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { failed++; continue; }
    const wtStr = typeIdx >= 0 && cols[typeIdx] ? cols[typeIdx].trim() : '정상근무';
    const workType = wtMap[wtStr] || 'normal';
    const checkIn  = inIdx >= 0 ? (cols[inIdx]?.trim() || null) : null;
    const checkOut = outIdx >= 0 ? (cols[outIdx]?.trim() || null) : null;
    const memo     = memoIdx >= 0 ? (cols[memoIdx]?.trim() || null) : null;
    const isLeave  = workType === 'annualLeave' || workType === 'holiday';
    await db.saveRecord({
      date,
      workType,
      checkIn:  isLeave ? null : checkIn,
      checkOut: isLeave ? null : checkOut,
      tripDestination: workType === 'businessTrip' ? memo : null,
      memo: workType !== 'businessTrip' ? memo : null,
    });
    imported++;
  }
  return { imported, skipped, failed };
}

function parseCsvRow(line) {
  const result = [];
  let inQ = false, buf = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i+1] === '"') { buf += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      result.push(buf); buf = '';
    } else buf += c;
  }
  result.push(buf);
  return result;
}

// ─── Modal helpers ─────────────────────────────────────
function openModal(html) {
  const overlay = document.getElementById('modal-overlay');
  const box = document.getElementById('modal-box');
  box.innerHTML = html;
  overlay.removeAttribute('hidden');
  document.getElementById('modal-close').onclick = closeModal;
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
}

function closeModal() {
  document.getElementById('modal-overlay').setAttribute('hidden', '');
}

// ─── Start ─────────────────────────────────────────────
boot().catch(console.error);
