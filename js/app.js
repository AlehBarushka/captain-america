const firebaseConfig = window.FIREBASE_CONFIG;
let db = null;
let auth = null;
let unsubscribeSchedule = null;
let currentUid = null;

if (
    firebaseConfig &&
    firebaseConfig.apiKey &&
    typeof firebase !== 'undefined' &&
    typeof firebase.initializeApp === 'function' &&
    typeof firebase.auth === 'function' &&
    typeof firebase.firestore === 'function'
) {
    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    db = firebase.firestore();
} else {
    console.warn(
        'Firebase config не найден. Скопируйте .env.example в .env, заполните ключи и выполните: python3 scripts/inject-firebase-config.py'
    );
}

// Коллекция и документ для хранения общих данных
const SCHEDULE_COLLECTION = 'family_schedule';
const SCHEDULE_DOC = 'main';
const PARAM_DEBOUNCE_MS = 400;

// ---------- Глобальные переменные состояния ----------
let loanAmount = 300000;
let annualRate = 15.4;
let years = 20;
let startDate = firstOfCurrentMonthISO();
let N = years * 12;
const BANK_YEAR_DAYS = 360;
let extras = new Array(N).fill(0);
let paidStatuses = new Array(N).fill(false);
let paymentDates = new Array(N).fill('');
let expandedRows = new Set();

let lastValidAmount = loanAmount;
let lastValidRate = annualRate;
let lastValidYears = years;
let lastValidStartDate = startDate;

const paramTimers = { amount: null, rate: null, years: null };
const extraDebounceTimers = new Map();

// Флаг, чтобы не сохранять данные до инициализации
let isInitialized = false;

// ---------- DOM элементы ----------
const amountInput = document.getElementById('amount');
const rateInput = document.getElementById('rate');
const yearsInput = document.getElementById('years');
const startDateInput = document.getElementById('start-date');
const tbody = document.getElementById('schedule-body');
const scheduleCards = document.getElementById('schedule-cards');
const bootScreen = document.getElementById('boot-screen');
const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app');
const userBar = document.getElementById('user-bar');
const userEmailEl = document.getElementById('user-email');
const loginForm = document.getElementById('login-form');
const loginEmail = document.getElementById('login-email');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const loginSubmit = document.getElementById('login-submit');
const logoutBtn = document.getElementById('logout-btn');
const tabbar = document.getElementById('tabbar');
const payInRange = document.getElementById('pay-in-range');
const payEmpty = document.getElementById('pay-empty');
const payMonthLabel = document.getElementById('pay-month-label');
const payBalance = document.getElementById('pay-balance');
const payInterest = document.getElementById('pay-interest');
const payPrincipal = document.getElementById('pay-principal');
const payMinimum = document.getElementById('pay-minimum');
const payForm = document.getElementById('pay-form');
const payAmountInput = document.getElementById('pay-amount');
const payError = document.getElementById('pay-error');
const payBtn = document.getElementById('pay-btn');
const payDone = document.getElementById('pay-done');
const payDoneAmount = document.getElementById('pay-done-amount');
const payDoneDate = document.getElementById('pay-done-date');

// ---------- Форматирование ----------
const moneyFormatter = new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'BYN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});
function formatMoney(value) { return moneyFormatter.format(value); }

function formatDate(date) {
    return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function firstOfCurrentMonthISO() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${now.getFullYear()}-${month}-01`;
}

function isValidISODate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function parseISODate(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
}

function daysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
}

function accrualDays(contractDateStr, index) {
    const start = parseISODate(contractDateStr);
    const accrual = new Date(start.getFullYear(), start.getMonth() + index, 1);
    const dim = daysInMonth(accrual.getFullYear(), accrual.getMonth());
    if (index === 0) return Math.max(0, dim - start.getDate());
    return 30;
}

function accrualPeriod(contractDateStr, index) {
    const start = parseISODate(contractDateStr);
    const monthDate = new Date(start.getFullYear(), start.getMonth() + index, 1);
    if (index === 0) {
        return {
            start: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1),
            end: new Date(start.getFullYear(), start.getMonth() + 1, 0),
            days: accrualDays(contractDateStr, index),
            bank30: false
        };
    }
    return {
        start: monthDate,
        end: new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0),
        days: 30,
        bank30: true
    };
}

function parsePaymentDate(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    let y;
    let m;
    let d;
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const ru = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (iso) {
        y = Number(iso[1]);
        m = Number(iso[2]);
        d = Number(iso[3]);
    } else if (ru) {
        d = Number(ru[1]);
        m = Number(ru[2]);
        y = Number(ru[3]);
    } else {
        return null;
    }
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    return date;
}

function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function calendarDayOffset(fromDate, toDate) {
    const a = Date.UTC(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
    const b = Date.UTC(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
    return Math.round((b - a) / 86400000);
}

// Сколько банковских дней периода прошло до date (date — первый день нового остатка).
function bankOffset(period, date) {
    if (!period.bank30) {
        if (calendarDayOffset(period.end, date) > 0) return period.days;
        return Math.max(0, calendarDayOffset(period.start, date));
    }
    const py = period.start.getFullYear();
    const pm = period.start.getMonth();
    const dy = date.getFullYear();
    const dm = date.getMonth();
    if (dy < py || (dy === py && dm < pm)) return 0;
    if (dy > py || (dy === py && dm > pm)) return period.days;
    return Math.min(date.getDate() - 1, period.days);
}

function reductionEffectiveDate(contractDate, paidIndex, paymentDateStr) {
    const paidOn = parsePaymentDate(paymentDateStr);
    if (paidOn) return addDays(paidOn, 1);
    return accrualPeriod(contractDate, paidIndex + 1).start;
}

function interestCentsForPeriod(openingCents, periodDays, cuts, ratePercent) {
    let cursor = 0;
    let balanceCents = openingCents;
    let weighted = 0;
    for (let i = 0; i < cuts.length; i++) {
        const at = cuts[i].offset;
        if (at > cursor) {
            weighted += fromCents(balanceCents) * (at - cursor);
            cursor = at;
        }
        balanceCents -= cuts[i].cents;
        if (balanceCents < 0) balanceCents = 0;
    }
    if (periodDays > cursor) weighted += fromCents(balanceCents) * (periodDays - cursor);
    return toCents(weighted * (ratePercent / 100) / BANK_YEAR_DAYS);
}

function formatMonthLabel(startDateStr, index) {
    const start = parseISODate(startDateStr);
    const d = new Date(start.getFullYear(), start.getMonth() + 1 + index, 1);
    const raw = d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
        .replace(/\s*г\.?$/u, '');
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function getCurrentMonthIndex(startDateStr) {
    const start = parseISODate(startDateStr);
    const paymentStart = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const now = new Date();
    return (now.getFullYear() - paymentStart.getFullYear()) * 12 + (now.getMonth() - paymentStart.getMonth());
}

function toCents(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.round(Number((value * 100).toFixed(8)));
}

function fromCents(cents) {
    return cents / 100;
}

function roundMoney(value) {
    return fromCents(toCents(value));
}

function parseNonNegNumber(raw) {
    if (raw === '' || raw === null || raw === undefined) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
}

function parseYears(raw) {
    const trimmed = String(raw).trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const n = parseInt(trimmed, 10);
    if (n < 1 || n > 50) return null;
    return n;
}

function isFocused(el) {
    return el && document.activeElement === el;
}

function getFocusedExtraIndex() {
    const el = document.activeElement;
    if (el && el.classList && el.classList.contains('extra-input')) {
        const idx = parseInt(el.getAttribute('data-month'), 10);
        return Number.isNaN(idx) ? -1 : idx;
    }
    return -1;
}

// ---------- Навигация ----------
function setActiveScreen(name) {
    document.querySelectorAll('.screen').forEach((screen) => {
        screen.classList.toggle('active', screen.dataset.screen === name);
    });
    document.querySelectorAll('.tabbar-btn').forEach((btn) => {
        const selected = btn.dataset.tab === name;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
}

// ---------- Построение таблицы и карточек ----------
function paidInputValue(scheduledPayment, extra) {
    return String(roundMoney((scheduledPayment || 0) + (extra || 0)));
}

function buildTable() {
    tbody.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < N; i++) {
        const tr = document.createElement('tr');
        tr.dataset.month = i;
        if (paidStatuses[i]) tr.classList.add('paid');
        tr.innerHTML = `
            <td class="col-group-1 month-num"></td>
            <td class="col-group-date payment-date">${paymentDates[i] || ''}</td>
            <td class="col-group-2 balance-before col-balance-before"></td>
            <td class="col-group-2 interest col-interest"></td>
            <td class="col-group-2 principal-plan col-principal-plan"></td>
            <td class="col-group-2 payment-plan col-payment-plan"></td>
            <td class="col-group-extra"><input type="number" class="extra-input" data-month="${i}" min="0" step="any" inputmode="decimal" value="0"></td>
            <td class="col-group-3 total-payment"></td>
            <td class="col-group-3 total-principal col-total-principal"></td>
            <td class="col-group-balance balance-after"></td>
            <td class="col-group-paid"><input type="checkbox" class="paid-checkbox" data-month="${i}" ${paidStatuses[i] ? 'checked' : ''}></td>
        `;
        fragment.appendChild(tr);
    }
    tbody.appendChild(fragment);
}

function buildCards() {
    scheduleCards.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < N; i++) {
        const card = document.createElement('article');
        card.className = 'month-card';
        card.dataset.month = i;
        card.innerHTML = `
            <div class="month-card-head">
                <div>
                    <div class="month-card-label"></div>
                    <div class="month-card-status"></div>
                </div>
                <div class="month-card-amounts">
                    <div class="plan"></div>
                    <div class="total"></div>
                    <span class="month-card-more"></span>
                </div>
            </div>
            <div class="month-card-details">
                <div class="details-grid">
                    <span>Остаток до: <strong class="det-balance-before"></strong></span>
                    <span>Проценты: <strong class="det-interest"></strong></span>
                    <span>Осн. долг: <strong class="det-principal-plan"></strong></span>
                    <span>Дата оплаты: <strong class="det-payment-date"></strong></span>
                </div>
                <div class="month-card-actions">
                    <label>Внесено
                        <input type="number" class="extra-input" data-month="${i}" min="0" step="any" inputmode="decimal" value="0">
                    </label>
                    <label>
                        <input type="checkbox" class="paid-checkbox" data-month="${i}" ${paidStatuses[i] ? 'checked' : ''}>
                        Оплачен
                    </label>
                </div>
            </div>
        `;
        fragment.appendChild(card);
    }
    scheduleCards.appendChild(fragment);
}

function setInputValueIfUnfocused(el, value) {
    if (!el || isFocused(el)) return;
    if (el.value !== value) el.value = value;
}

function clearExtraTimers() {
    extraDebounceTimers.forEach((timer) => clearTimeout(timer));
    extraDebounceTimers.clear();
}

function padScheduleArrays() {
    extras = extras.slice(0, N);
    while (extras.length < N) extras.push(0);
    paidStatuses = paidStatuses.slice(0, N);
    while (paidStatuses.length < N) paidStatuses.push(false);
    paymentDates = paymentDates.slice(0, N);
    while (paymentDates.length < N) paymentDates.push('');
}

function syncHorizon() {
    const newN = years * 12;
    const resized = newN !== N;
    if (resized) {
        clearExtraTimers();
        N = newN;
    }
    padScheduleArrays();
    return resized;
}

// ---------- Расчёт графика ----------
function amortizeLoan(amount, n, ratePercent, extrasList, contractDate, paymentDateList) {
    const dates = paymentDateList || [];
    let balanceCents = toCents(amount);
    const rows = [];
    const reductions = [];
    let totalPaymentCents = 0;
    let totalInterestCents = 0;
    let totalPrincipalCents = 0;
    let totalExtraCents = 0;

    for (let i = 0; i < n; i++) {
        const remainingMonths = n - i;
        const balanceBeforeCents = balanceCents;
        const balanceRubles = fromCents(balanceBeforeCents);
        const period = accrualPeriod(contractDate, i);

        // Погашение тела действует со следующего дня после даты оплаты.
        // Если эта дата внутри периода, проценты до неё — по старому остатку.
        let openingCents = balanceBeforeCents;
        const cuts = [];
        for (let r = 0; r < reductions.length; r++) {
            const offset = bankOffset(period, reductions[r].effective);
            if (offset >= period.days) {
                openingCents += reductions[r].cents;
            } else if (offset > 0) {
                openingCents += reductions[r].cents;
                cuts.push({ offset, cents: reductions[r].cents });
            }
        }
        cuts.sort((a, b) => a.offset - b.offset);
        const interestCents = interestCentsForPeriod(openingCents, period.days, cuts, ratePercent);

        // Первые 12 месяцев — только проценты. Срок не растёт: с 13-го месяца
        // остаток делится на оставшиеся месяцы. Последний месяц срока закрывает остаток.
        let scheduledPrincipalCents;
        if (i < 12 && remainingMonths > 1) {
            scheduledPrincipalCents = 0;
        } else if (remainingMonths <= 1) {
            scheduledPrincipalCents = balanceCents;
        } else {
            scheduledPrincipalCents = toCents(balanceRubles / remainingMonths);
        }
        if (scheduledPrincipalCents > balanceCents) scheduledPrincipalCents = balanceCents;
        if (scheduledPrincipalCents < 0) scheduledPrincipalCents = 0;

        const extraCents = Math.max(0, toCents(extrasList[i] || 0));
        const maxExtraCents = Math.max(0, balanceCents - scheduledPrincipalCents);
        const extraAppliedCents = Math.min(extraCents, maxExtraCents);

        const scheduledPaymentCents = interestCents + scheduledPrincipalCents;
        const totalPrincipalMonthCents = scheduledPrincipalCents + extraAppliedCents;
        const totalPaymentMonthCents = interestCents + totalPrincipalMonthCents;
        if (totalPrincipalMonthCents > 0) {
            reductions.push({
                effective: reductionEffectiveDate(contractDate, i, dates[i]),
                cents: totalPrincipalMonthCents
            });
        }
        balanceCents -= totalPrincipalMonthCents;

        totalPaymentCents += totalPaymentMonthCents;
        totalInterestCents += interestCents;
        totalPrincipalCents += totalPrincipalMonthCents;
        totalExtraCents += extraAppliedCents;

        rows.push({
            index: i,
            balanceBefore: fromCents(balanceBeforeCents),
            interest: fromCents(interestCents),
            scheduledPrincipal: fromCents(scheduledPrincipalCents),
            scheduledPayment: fromCents(scheduledPaymentCents),
            extra: fromCents(extraCents),
            extraApplied: fromCents(extraAppliedCents),
            maxExtra: fromCents(maxExtraCents),
            maxPayment: fromCents(interestCents + balanceBeforeCents),
            totalPayment: fromCents(totalPaymentMonthCents),
            totalPrincipal: fromCents(totalPrincipalMonthCents),
            balanceAfter: fromCents(balanceCents)
        });
    }

    return {
        rows,
        totals: {
            totalPayment: fromCents(totalPaymentCents),
            totalInterest: fromCents(totalInterestCents),
            totalPrincipal: fromCents(totalPrincipalCents),
            totalExtra: fromCents(totalExtraCents)
        }
    };
}

function computeSchedule() {
    const plan = amortizeLoan(loanAmount, N, annualRate, [], startDate);
    const appliedExtras = extras.map((value, i) => (paidStatuses[i] ? value : 0));
    const appliedDates = paymentDates.map((value, i) => (paidStatuses[i] ? value : ''));
    const adjusted = amortizeLoan(loanAmount, N, annualRate, appliedExtras, startDate, appliedDates);

    let factPaymentCents = 0;
    let factInterestCents = 0;
    let factPrincipalCents = 0;
    let paidMonthsCount = 0;

    const rows = adjusted.rows.map((row, i) => {
        const paid = !!paidStatuses[i];
        if (paid) {
            factPaymentCents += toCents(row.totalPayment);
            factInterestCents += toCents(row.interest);
            factPrincipalCents += toCents(row.totalPrincipal);
            paidMonthsCount++;
        }
        return {
            ...row,
            label: formatMonthLabel(startDate, i),
            paymentDate: paid ? paymentDates[i] || '' : '',
            paid
        };
    });

    return {
        rows,
        currentIndex: getCurrentMonthIndex(startDate),
        totals: {
            totalPaymentSum: plan.totals.totalPayment,
            totalInterestSum: plan.totals.totalInterest,
            totalPrincipalSum: plan.totals.totalPrincipal,
            firstPayment: plan.rows[0] ? plan.rows[0].scheduledPayment : 0,
            adjTotalPayment: adjusted.totals.totalPayment,
            adjTotalInterest: adjusted.totals.totalInterest,
            adjTotalPrincipal: adjusted.totals.totalPrincipal,
            totalExtraSum: adjusted.totals.totalExtra,
            interestSaved: fromCents(toCents(plan.totals.totalInterest) - toCents(adjusted.totals.totalInterest)),
            factTotalPayment: fromCents(factPaymentCents),
            factTotalInterest: fromCents(factInterestCents),
            factTotalPrincipal: fromCents(factPrincipalCents),
            paidMonthsCount
        }
    };
}

function renderTable(schedule) {
    const rows = tbody.querySelectorAll('tr[data-month]');
    schedule.rows.forEach((row, i) => {
        const tr = rows[i];
        if (!tr) return;
        const cells = tr.cells;
        cells[0].textContent = row.label;
        cells[1].textContent = row.paymentDate;
        cells[2].textContent = formatMoney(row.balanceBefore);
        cells[3].textContent = formatMoney(row.interest);
        cells[4].textContent = formatMoney(row.scheduledPrincipal);
        cells[5].textContent = formatMoney(row.scheduledPayment);
        cells[7].textContent = formatMoney(row.totalPayment);
        cells[8].textContent = formatMoney(row.totalPrincipal);
        cells[9].textContent = formatMoney(row.balanceAfter);
        setInputValueIfUnfocused(tr.querySelector('.extra-input'), paidInputValue(row.scheduledPayment, extras[i] || 0));
        const checkbox = tr.querySelector('.paid-checkbox');
        if (checkbox) checkbox.checked = row.paid;
        tr.classList.toggle('paid', row.paid);
        tr.classList.toggle('current', i === schedule.currentIndex);
    });
}

function renderCards(schedule) {
    const cards = scheduleCards.querySelectorAll('.month-card');
    schedule.rows.forEach((row, i) => {
        const card = cards[i];
        if (!card) return;
        card.querySelector('.month-card-label').innerHTML =
            `${row.label} <span class="month-card-now">Сейчас</span>`;
        card.querySelector('.month-card-status').textContent = row.paid ? 'Оплачен' : 'Не оплачен';
        card.querySelector('.plan').textContent = `План: ${formatMoney(row.scheduledPayment)}`;
        card.querySelector('.total').textContent = `Итог: ${formatMoney(row.totalPayment)}`;
        card.querySelector('.det-balance-before').textContent = formatMoney(row.balanceBefore);
        card.querySelector('.det-interest').textContent = formatMoney(row.interest);
        card.querySelector('.det-principal-plan').textContent = formatMoney(row.scheduledPrincipal);
        card.querySelector('.det-payment-date').textContent = row.paymentDate || '—';
        setInputValueIfUnfocused(card.querySelector('.extra-input'), paidInputValue(row.scheduledPayment, extras[i] || 0));
        const checkbox = card.querySelector('.paid-checkbox');
        if (checkbox) checkbox.checked = row.paid;
        card.classList.toggle('paid', row.paid);
        card.classList.toggle('current', i === schedule.currentIndex);
        card.classList.toggle('expanded', expandedRows.has(i));
    });
}

function setTextById(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function renderSummary(schedule) {
    const t = schedule.totals;
    setTextById('sum-total-payment', formatMoney(t.totalPaymentSum));
    setTextById('sum-total-interest', formatMoney(t.totalInterestSum));
    setTextById('sum-total-principal', formatMoney(t.totalPrincipalSum));
    setTextById('sum-first-payment', formatMoney(t.firstPayment));

    const adjustGroup = document.getElementById('summary-group-adjust');
    const hasExtras = t.totalExtraSum > 0;
    if (adjustGroup) adjustGroup.hidden = !hasExtras;
    if (hasExtras) {
        setTextById('adj-total-payment', formatMoney(t.adjTotalPayment));
        setTextById('adj-total-interest', formatMoney(t.adjTotalInterest));
        setTextById('adj-interest-saved', formatMoney(t.interestSaved));
        setTextById('sum-total-extra', formatMoney(t.totalExtraSum));
    }

    setTextById('fact-total-payment', formatMoney(t.factTotalPayment));
    setTextById('fact-total-interest', formatMoney(t.factTotalInterest));
    setTextById('fact-total-principal', formatMoney(t.factTotalPrincipal));
    setTextById('paid-months-count', t.paidMonthsCount);
}

function renderPayCard(schedule) {
    if (!isInitialized) {
        payInRange.hidden = true;
        payEmpty.hidden = true;
        return;
    }

    const { rows, currentIndex } = schedule;
    const inRange = currentIndex >= 0 && currentIndex < N;
    payEmpty.hidden = inRange;
    payInRange.hidden = !inRange;

    if (!inRange) {
        payEmpty.textContent = currentIndex < 0
            ? 'Платежи ещё не начались'
            : 'График завершён';
        return;
    }

    const row = rows[currentIndex];
    payMonthLabel.textContent = row.label;
    payBalance.textContent = formatMoney(row.balanceBefore);
    payInterest.textContent = formatMoney(row.interest);
    payPrincipal.textContent = formatMoney(row.scheduledPrincipal);
    payMinimum.textContent = formatMoney(row.scheduledPayment);

    if (row.paid) {
        payForm.hidden = true;
        payDone.hidden = false;
        payDoneAmount.textContent = formatMoney(row.totalPayment);
        payDoneDate.textContent = row.paymentDate || '—';
    } else {
        payForm.hidden = false;
        payDone.hidden = true;
        if (!isFocused(payAmountInput)) {
            payAmountInput.value = roundMoney(row.scheduledPayment).toFixed(2);
        }
    }
}

function recalc() {
    const resized = syncHorizon();
    if (resized || tbody.children.length !== N || scheduleCards.children.length !== N) {
        buildTable();
        buildCards();
    }
    const schedule = computeSchedule();
    renderTable(schedule);
    renderCards(schedule);
    renderSummary(schedule);
    renderPayCard(schedule);
    return schedule;
}

// ---------- Сохранение данных в Firestore ----------
async function saveToFirebase() {
    if (!isInitialized || !db) return;
    if (auth && !auth.currentUser) return;
    try {
        await db.collection(SCHEDULE_COLLECTION).doc(SCHEDULE_DOC).set({
            extras: extras,
            paidStatuses: paidStatuses,
            paymentDates: paymentDates,
            amount: loanAmount,
            rate: annualRate,
            years: years,
            startDate: startDate,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (e) {
        console.error('Ошибка сохранения в Firebase:', e);
    }
}

function applyExtraDateSideEffect(idx) {
    if (paidStatuses[idx] && extras[idx] > 0 && !paymentDates[idx]) {
        paymentDates[idx] = formatDate(new Date());
    } else if (extras[idx] === 0 && !paidStatuses[idx]) {
        paymentDates[idx] = '';
    }
}

function commitExtraFromInput(idx, input, { emptyToZero = false } = {}) {
    const row = computeSchedule().rows[idx];
    if (!row) return false;
    const min = roundMoney(row.scheduledPayment);
    const max = roundMoney(row.maxPayment);
    const restorePaid = () => {
        input.value = paidInputValue(min, extras[idx] || 0);
    };

    const raw = input.value;
    if (raw === '') {
        if (!emptyToZero) return false;
        extras[idx] = 0;
        restorePaid();
        applyExtraDateSideEffect(idx);
        return true;
    }
    const val = parseNonNegNumber(raw);
    if (val === null) {
        if (emptyToZero) restorePaid();
        return false;
    }
    const value = roundMoney(val);
    if (value < min || value > max) {
        if (emptyToZero) restorePaid();
        return false;
    }
    extras[idx] = roundMoney(value - min);
    if (emptyToZero) restorePaid();
    applyExtraDateSideEffect(idx);
    return true;
}

function commitAmount({ emptyToZero = false } = {}) {
    let raw = amountInput.value;
    if (raw === '') {
        if (!emptyToZero) return false;
        raw = '0';
        amountInput.value = '0';
    }
    const n = parseNonNegNumber(raw);
    if (n === null) return false;
    loanAmount = roundMoney(n);
    lastValidAmount = loanAmount;
    return true;
}

function commitRate({ emptyToZero = false } = {}) {
    let raw = rateInput.value;
    if (raw === '') {
        if (!emptyToZero) return false;
        raw = '0';
        rateInput.value = '0';
    }
    const n = parseNonNegNumber(raw);
    if (n === null) return false;
    annualRate = n;
    lastValidRate = n;
    return true;
}

function commitYears({ restoreOnInvalid = false } = {}) {
    const raw = yearsInput.value;
    if (raw === '') {
        if (restoreOnInvalid) yearsInput.value = String(lastValidYears);
        return false;
    }
    const parsed = parseYears(raw);
    if (parsed === null) {
        if (restoreOnInvalid) yearsInput.value = String(lastValidYears);
        return false;
    }
    years = parsed;
    lastValidYears = parsed;
    return true;
}

function commitStartDate() {
    const raw = startDateInput.value;
    if (!isValidISODate(raw)) return false;
    startDate = raw;
    lastValidStartDate = raw;
    return true;
}

function scheduleParamCommit(key, commitFn) {
    if (paramTimers[key]) clearTimeout(paramTimers[key]);
    paramTimers[key] = setTimeout(() => {
        paramTimers[key] = null;
        if (commitFn()) {
            recalc();
            saveToFirebase();
        }
    }, PARAM_DEBOUNCE_MS);
}

function bindDebouncedField(input, key, commitFn, blurCommitFn) {
    input.addEventListener('input', () => {
        scheduleParamCommit(key, commitFn);
    });
    input.addEventListener('blur', () => {
        if (paramTimers[key]) {
            clearTimeout(paramTimers[key]);
            paramTimers[key] = null;
        }
        if ((blurCommitFn || commitFn)()) {
            recalc();
            saveToFirebase();
        }
    });
}

// ---------- Загрузка данных из Firestore и подписка на изменения ----------
function teardownSync() {
    if (unsubscribeSchedule) {
        unsubscribeSchedule();
        unsubscribeSchedule = null;
    }
    isInitialized = false;
}

function applySnapshotField(input, incoming, applyValue) {
    if (incoming === undefined) return;
    if (isFocused(input)) return;
    applyValue(incoming);
}

function initFirebaseListener(onReady) {
    let settled = false;
    const ready = () => {
        if (settled) return;
        settled = true;
        if (typeof onReady === 'function') onReady();
    };

    if (!db) {
        isInitialized = true;
        recalc();
        ready();
        return;
    }
    teardownSync();
    unsubscribeSchedule = db.collection(SCHEDULE_COLLECTION).doc(SCHEDULE_DOC)
        .onSnapshot((doc) => {
            if (doc.exists) {
                const data = doc.data();
                const focusedExtra = getFocusedExtraIndex();
                if (data.extras && Array.isArray(data.extras)) {
                    const next = data.extras.slice(0, Math.max(N, data.extras.length));
                    if (focusedExtra >= 0 && focusedExtra < extras.length) {
                        next[focusedExtra] = extras[focusedExtra];
                    }
                    extras = next;
                }
                if (data.paidStatuses && Array.isArray(data.paidStatuses)) {
                    paidStatuses = data.paidStatuses.slice();
                }
                if (data.paymentDates && Array.isArray(data.paymentDates)) {
                    paymentDates = data.paymentDates.slice();
                }

                applySnapshotField(amountInput, data.amount, (value) => {
                    const n = parseNonNegNumber(value);
                    if (n === null) return;
                    loanAmount = n;
                    lastValidAmount = n;
                    amountInput.value = String(value);
                });
                applySnapshotField(rateInput, data.rate, (value) => {
                    const n = parseNonNegNumber(value);
                    if (n === null) return;
                    annualRate = n;
                    lastValidRate = n;
                    rateInput.value = String(value);
                });
                applySnapshotField(yearsInput, data.years, (value) => {
                    const parsed = parseYears(value);
                    if (parsed === null) return;
                    years = parsed;
                    lastValidYears = parsed;
                    yearsInput.value = String(parsed);
                });

                let shouldPersistStartDate = false;
                if (data.startDate && isValidISODate(data.startDate)) {
                    applySnapshotField(startDateInput, data.startDate, (value) => {
                        startDate = value;
                        lastValidStartDate = value;
                        startDateInput.value = value;
                    });
                } else if (!isFocused(startDateInput)) {
                    startDate = firstOfCurrentMonthISO();
                    lastValidStartDate = startDate;
                    startDateInput.value = startDate;
                    shouldPersistStartDate = true;
                }

                isInitialized = true;
                recalc();
                if (shouldPersistStartDate) {
                    saveToFirebase();
                }
            } else {
                isInitialized = true;
                recalc();
                saveToFirebase();
            }
            ready();
        }, (error) => {
            console.error('Ошибка получения данных из Firebase:', error);
            isInitialized = true;
            recalc();
            ready();
        });
}

function showPayError(message) {
    payError.textContent = message;
    payError.hidden = false;
}

function hidePayError() {
    payError.hidden = true;
    payError.textContent = '';
}

function payCurrentMonth() {
    const schedule = computeSchedule();
    const idx = schedule.currentIndex;
    if (idx < 0 || idx >= N) return;
    const row = schedule.rows[idx];
    if (row.paid) return;

    const raw = payAmountInput.value;
    const amount = parseNonNegNumber(raw);
    if (raw === '' || amount === null) {
        showPayError('Введите сумму платежа');
        return;
    }

    const min = roundMoney(row.scheduledPayment);
    const max = roundMoney(row.maxPayment);
    const value = roundMoney(amount);

    if (value < min) {
        showPayError(`Сумма меньше минимума (${formatMoney(min)})`);
        return;
    }
    if (value > max) {
        showPayError(`Сумма больше полной выплаты (${formatMoney(max)})`);
        return;
    }

    hidePayError();
    extras[idx] = roundMoney(value - min);
    paidStatuses[idx] = true;
    paymentDates[idx] = formatDate(new Date());
    recalc();
    saveToFirebase();
}

// ---------- Обработчики событий ----------
function onScheduleInput(e) {
    if (!e.target.classList.contains('extra-input')) return;
    const idx = parseInt(e.target.getAttribute('data-month'), 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= N) return;
    const prev = extraDebounceTimers.get(idx);
    if (prev) clearTimeout(prev);
    extraDebounceTimers.set(idx, setTimeout(() => {
        extraDebounceTimers.delete(idx);
        if (commitExtraFromInput(idx, e.target)) {
            recalc();
            saveToFirebase();
        }
    }, PARAM_DEBOUNCE_MS));
}

function onScheduleExtraBlur(e) {
    if (!e.target.classList.contains('extra-input')) return;
    const idx = parseInt(e.target.getAttribute('data-month'), 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= N) return;
    const prev = extraDebounceTimers.get(idx);
    if (prev) {
        clearTimeout(prev);
        extraDebounceTimers.delete(idx);
    }
    if (commitExtraFromInput(idx, e.target, { emptyToZero: true })) {
        recalc();
        saveToFirebase();
    }
}

function onScheduleChange(e) {
    if (!e.target.classList.contains('paid-checkbox')) return;
    const idx = parseInt(e.target.getAttribute('data-month'), 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= N) return;
    paidStatuses[idx] = e.target.checked;
    if (paidStatuses[idx] && !paymentDates[idx]) {
        paymentDates[idx] = formatDate(new Date());
    } else if (!paidStatuses[idx] && extras[idx] === 0) {
        paymentDates[idx] = '';
    }
    recalc();
    saveToFirebase();
}

function onCardClick(e) {
    if (e.target.closest('input, label, button')) return;
    const card = e.target.closest('.month-card');
    if (!card) return;
    const month = parseInt(card.dataset.month, 10);
    if (Number.isNaN(month)) return;
    if (expandedRows.has(month)) {
        expandedRows.delete(month);
        card.classList.remove('expanded');
    } else {
        expandedRows.add(month);
        card.classList.add('expanded');
    }
}

tbody.addEventListener('input', onScheduleInput);
tbody.addEventListener('focusout', onScheduleExtraBlur);
tbody.addEventListener('change', onScheduleChange);

scheduleCards.addEventListener('input', onScheduleInput);
scheduleCards.addEventListener('focusout', onScheduleExtraBlur);
scheduleCards.addEventListener('change', onScheduleChange);
scheduleCards.addEventListener('click', onCardClick);

bindDebouncedField(amountInput, 'amount', () => commitAmount(), () => commitAmount({ emptyToZero: true }));
bindDebouncedField(rateInput, 'rate', () => commitRate(), () => commitRate({ emptyToZero: true }));
bindDebouncedField(yearsInput, 'years', () => commitYears(), () => commitYears({ restoreOnInvalid: true }));

startDateInput.addEventListener('change', () => {
    if (commitStartDate()) {
        recalc();
        saveToFirebase();
    }
});
startDateInput.addEventListener('blur', () => {
    if (!commitStartDate()) {
        startDateInput.value = lastValidStartDate;
        return;
    }
    recalc();
    saveToFirebase();
});

tabbar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    setActiveScreen(btn.dataset.tab);
});

payBtn.addEventListener('click', payCurrentMonth);
payAmountInput.addEventListener('input', hidePayError);

function authErrorMessage(err) {
    switch (err && err.code) {
        case 'auth/invalid-email':
            return 'Некорректный email.';
        case 'auth/operation-not-allowed':
            return 'Вход по email пока недоступен.';
        case 'auth/unauthorized-domain':
            return 'Вход с этого адреса недоступен.';
        case 'auth/user-disabled':
            return 'Учётная запись отключена.';
        case 'auth/user-not-found':
        case 'auth/wrong-password':
        case 'auth/invalid-credential':
        case 'auth/invalid-login-credentials':
            return 'Неверный email или пароль.';
        case 'auth/too-many-requests':
            return 'Слишком много попыток. Подождите и попробуйте снова.';
        case 'auth/network-request-failed':
            return 'Нет сети. Проверьте подключение.';
        default:
            return 'Не удалось войти. Попробуйте ещё раз.';
    }
}

function hideBoot() {
    bootScreen.hidden = true;
}

function showBoot() {
    bootScreen.hidden = false;
    loginScreen.hidden = true;
    appScreen.hidden = true;
}

function showLogin() {
    hideBoot();
    loginScreen.hidden = false;
    appScreen.hidden = true;
    userBar.hidden = true;
}

function showApp(email) {
    hideBoot();
    loginScreen.hidden = true;
    appScreen.hidden = false;
    if (email) {
        userEmailEl.textContent = email;
        userBar.hidden = false;
    } else {
        userEmailEl.textContent = '';
        userBar.hidden = true;
    }
}

function bindAuthUI() {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginError.hidden = true;
        loginSubmit.disabled = true;
        try {
            await auth.signInWithEmailAndPassword(loginEmail.value.trim(), loginPassword.value);
            loginForm.reset();
        } catch (err) {
            console.error('Ошибка входа:', err);
            loginError.textContent = authErrorMessage(err);
            loginError.hidden = false;
        } finally {
            loginSubmit.disabled = false;
        }
    });

    logoutBtn.addEventListener('click', async () => {
        teardownSync();
        try {
            await auth.signOut();
        } catch (err) {
            console.error('Ошибка выхода:', err);
        }
    });
}

// ---------- Инициализация ----------
startDateInput.value = startDate;
buildTable();
buildCards();

if (!auth) {
    isInitialized = true;
    recalc();
    showApp(null);
} else {
    bindAuthUI();
    auth.onAuthStateChanged((user) => {
        if (user) {
            if (currentUid !== user.uid) {
                currentUid = user.uid;
                showBoot();
                initFirebaseListener(() => showApp(user.email || ''));
            }
        } else {
            currentUid = null;
            teardownSync();
            showLogin();
        }
    });
}
