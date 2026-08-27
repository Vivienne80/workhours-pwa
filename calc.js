// Work time calculations (mirrors Flutter work_calculator.dart)

export const WORK_TYPES = {
  normal:            { label: '근무일',    color: '#1976d2' },
  annualLeave:       { label: '연차',      color: '#388e3c' },
  halfDay:           { label: '반차',      color: '#f57c00' },
  quarterDay:        { label: '반반차',    color: '#fb8c00' },
  doubleQuarterDay:  { label: '반반차×2',  color: '#e64a19' },
  businessTrip:      { label: '출장',      color: '#7b1fa2' },
  holidayWork:       { label: '휴일근무',  color: '#d32f2f' },
  remote:            { label: '재택근무',  color: '#00796b' },
  holiday:           { label: '휴일',      color: '#9e9e9e' },
};

// 'HH:MM' → minutes (int), null on failure
export function parseTime(s) {
  if (!s) return null;
  const [h, m] = s.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  if (h === 0 && m === 0) return null;
  return h * 60 + m;
}

// minutes → 'HH:MM'
export function formatTime(total) {
  const neg = total < 0;
  const abs = Math.abs(total);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return (neg ? '-' : '') + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// round minutes to nearest 15
export function roundTo15(minutes) {
  return Math.round(minutes / 15) * 15;
}

// current time rounded to 15min → 'HH:MM'
export function currentTime15() {
  const now = new Date();
  return formatTime(roundTo15(now.getHours() * 60 + now.getMinutes()));
}

// base required work minutes for a work type
export function baseWorkMinutes(workType) {
  switch (workType) {
    case 'normal':
    case 'businessTrip':
    case 'remote':
      return 8 * 60;
    case 'halfDay':
      return 4 * 60;
    case 'quarterDay':
      return 6 * 60;
    case 'doubleQuarterDay':
      return 4 * 60;
    default:
      return 0;
  }
}

// actual work minutes for a record (after lunch deduction), null if data missing
export function calcDailyWork(record) {
  if (record.workType === 'annualLeave' || record.workType === 'holiday') return 0;
  const ci = parseTime(record.checkIn);
  const co = parseTime(record.checkOut);
  if (ci === null || co === null) return null;
  let worked = co - ci;
  if (worked < 0) return null;
  // 1h lunch deduction for normal/businessTrip/remote/quarterDay/doubleQuarterDay
  if (['normal', 'businessTrip', 'remote', 'quarterDay', 'doubleQuarterDay'].includes(record.workType)) {
    worked = Math.max(0, worked - 60);
  }
  return worked;
}

// overtime minutes for a record (>=0)
export function calcOvertime(record) {
  const worked = calcDailyWork(record);
  if (worked === null) return 0;
  return Math.max(0, worked - baseWorkMinutes(record.workType));
}

// realtime work minutes for today (lunch deducted after 12:50)
export function calcTodayRealtime(checkIn) {
  const ci = parseTime(checkIn);
  if (ci === null) return 0;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let worked = nowMin - ci;
  if (worked < 0) return 0;
  const LUNCH_END = 12 * 60 + 50;
  if (nowMin >= LUNCH_END) {
    worked = Math.max(0, worked - 60);
  }
  return worked;
}

// standard checkout: checkIn + 9h (8h work + 1h lunch) → 'HH:MM'
export function checkoutStandard(checkIn) {
  const ci = parseTime(checkIn);
  if (ci === null) return null;
  return formatTime(ci + 9 * 60);
}

// minimum checkout considering lunch window + coretime + monthly overtime
export function checkoutMinimum(checkIn, monthlyOvertimeMin = 0, hasCoreTime = false) {
  const ci = parseTime(checkIn);
  if (ci === null) return '--:--';

  const LUNCH_START = 11 * 60 + 50;
  const LUNCH_END   = 12 * 60 + 50;
  const CORE_END    = 14 * 60;

  const needed = Math.max(0, 8 * 60 - monthlyOvertimeMin);

  let minOut;
  if (ci >= LUNCH_END) {
    minOut = ci + needed;
  } else if (ci >= LUNCH_START) {
    minOut = LUNCH_END + needed;
  } else {
    const beforeLunch = LUNCH_START - ci;
    if (needed <= beforeLunch) {
      minOut = ci + needed;
    } else {
      minOut = ci + needed + 60;
    }
  }

  // ceil to 15min
  const rem = minOut % 15;
  if (rem !== 0) minOut += (15 - rem);

  if (hasCoreTime && minOut < CORE_END) minOut = CORE_END;

  return formatTime(minOut);
}
