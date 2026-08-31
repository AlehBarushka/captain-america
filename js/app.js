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
let monthlyRate = annualRate / 100 / 12;
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

function formatMonthLabel(startDateStr, index) {
    const start = parseISODate(startDateStr);
    const d = new Date(start.getFullYear(), start.getMonth() + index, 1);
    const raw = d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
        .replace(/\s*г\.?$/u, '');
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function getCurrentMonthIndex(startDateStr) {
    const start = parseISODate(startDateStr);
    const now = new Date();
    return (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
}

function roundMoney(value) {
    return Math.round(value * 100) / 100;
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
function extraInputValue(value) {
    return value ? String(value) : '0';
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
            <td class="col-group-extra"><input type="number" class="extra-input" data-month="${i}" min="0" step="any" inputmode="decimal" value="${extraInputValue(extras[i])}"></td>
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
                    <label>Доп. платёж
                        <input type="number" class="extra-input" data-month="${i}" min="0" step="any" inputmode="decimal" value="${extraInputValue(extras[i])}">
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
function computeSchedule() {
    monthlyRate = annualRate / 100 / 12;
    const rows = [];
    let balance = loanAmount;
    let totalPaymentSum = 0;
    let totalInterestSum = 0;
    let totalPrincipalSum = 0;
    let totalExtraSum = 0;
    let factTotalPayment = 0;
    let factTotalInterest = 0;
    let factTotalPrincipal = 0;
    let paidMonthsCount = 0;

    for (let i = 0; i < N; i++) {
        const remainingMonths = N - i;
        const balanceBefore = balance;
        const interest = balance * monthlyRate;
        const scheduledPrincipal = remainingMonths > 0 ? balance / remainingMonths : 0;
        const scheduledPayment = interest + scheduledPrincipal;
        let extra = extras[i] || 0;
        if (extra < 0) extra = 0;
        const maxExtra = Math.max(0, balance - scheduledPrincipal);
        const extraApplied = Math.min(extra, maxExtra);
        const totalPayment = scheduledPayment + extraApplied;
        const totalPrincipal = scheduledPrincipal + extraApplied;
        balance = balance - totalPrincipal;
        balance = roundMoney(balance);
        if (Math.abs(balance) < 0.005) balance = 0;

        totalPaymentSum += totalPayment;
        totalInterestSum += interest;
        totalPrincipalSum += totalPrincipal;
        totalExtraSum += extraApplied;

        if (paidStatuses[i]) {
            factTotalPayment += totalPayment;
            factTotalInterest += interest;
            factTotalPrincipal += totalPrincipal;
            paidMonthsCount++;
        }

        rows.push({
            index: i,
            label: formatMonthLabel(startDate, i),
            paymentDate: paymentDates[i] || '',
            balanceBefore,
            interest,
            scheduledPrincipal,
            scheduledPayment,
            extra,
            extraApplied,
            maxExtra,
            maxPayment: interest + balanceBefore,
            totalPayment,
            totalPrincipal,
            balanceAfter: balance,
            paid: !!paidStatuses[i]
        });
    }

    return {
        rows,
        currentIndex: getCurrentMonthIndex(startDate),
        totals: {
            totalPaymentSum,
            totalInterestSum,
            totalPrincipalSum,
            totalExtraSum,
            factTotalPayment,
            factTotalInterest,
            factTotalPrincipal,
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
        setInputValueIfUnfocused(tr.querySelector('.extra-input'), extraInputValue(extras[i] || 0));
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
        setInputValueIfUnfocused(card.querySelector('.extra-input'), extraInputValue(extras[i] || 0));
        const checkbox = card.querySelector('.paid-checkbox');
        if (checkbox) checkbox.checked = row.paid;
        card.classList.toggle('paid', row.paid);
        card.classList.toggle('current', i === schedule.currentIndex);
        card.classList.toggle('expanded', expandedRows.has(i));
    });
}

function renderSummary(schedule) {
    const t = schedule.totals;
    document.getElementById('sum-total-payment').textContent = formatMoney(t.totalPaymentSum);
    document.getElementById('sum-total-interest').textContent = formatMoney(t.totalInterestSum);
    document.getElementById('sum-total-principal').textContent = formatMoney(t.totalPrincipalSum);
    document.getElementById('sum-total-extra').textContent = formatMoney(t.totalExtraSum);
    document.getElementById('fact-total-payment').textContent = formatMoney(t.factTotalPayment);
    document.getElementById('fact-total-interest').textContent = formatMoney(t.factTotalInterest);
    document.getElementById('fact-total-principal').textContent = formatMoney(t.factTotalPrincipal);
    document.getElementById('paid-months-count').textContent = t.paidMonthsCount;
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
    if (extras[idx] > 0 && !paymentDates[idx]) {
        paymentDates[idx] = formatDate(new Date());
    } else if (extras[idx] === 0 && !paidStatuses[idx]) {
        paymentDates[idx] = '';
    }
}

function commitExtraFromInput(idx, input, { emptyToZero = false } = {}) {
    const raw = input.value;
    if (raw === '') {
        if (!emptyToZero) return false;
        extras[idx] = 0;
        input.value = '0';
        applyExtraDateSideEffect(idx);
        return true;
    }
    const val = parseNonNegNumber(raw);
    if (val === null) return false;
    extras[idx] = val;
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
    loanAmount = n;
    lastValidAmount = n;
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
