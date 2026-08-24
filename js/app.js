const firebaseConfig = window.FIREBASE_CONFIG;
let db = null;
let auth = null;
let unsubscribeSchedule = null;
let currentUid = null;

if (firebaseConfig && firebaseConfig.apiKey) {
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

// ---------- Глобальные переменные состояния ----------
let loanAmount = 300000;
let annualRate = 15.4;
let years = 20;
let N = years * 12;
let monthlyRate = annualRate / 100 / 12;
let extras = new Array(N).fill(0);
let paidStatuses = new Array(N).fill(false);
let paymentDates = new Array(N).fill('');
let expandedRows = new Set();

// Флаг, чтобы не сохранять данные до инициализации
let isInitialized = false;

// ---------- DOM элементы ----------
const amountInput = document.getElementById('amount');
const rateInput = document.getElementById('rate');
const yearsInput = document.getElementById('years');
const tbody = document.getElementById('schedule-body');
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

// ---------- Построение таблицы ----------
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
            <td class="col-group-extra"><input type="number" class="extra-input" data-month="${i}" min="0" step="0.01" value="${extras[i] || 0}"></td>
            <td class="col-group-3 total-payment"></td>
            <td class="col-group-3 total-principal col-total-principal"></td>
            <td class="col-group-balance balance-after"></td>
            <td class="col-group-paid"><input type="checkbox" class="paid-checkbox" data-month="${i}" ${paidStatuses[i] ? 'checked' : ''}></td>
        `;
        const detailsTr = document.createElement('tr');
        detailsTr.className = 'details-row';
        detailsTr.dataset.detailsFor = i;
        detailsTr.innerHTML = `
            <td colspan="11" class="details-cell">
                <div class="details-grid">
                    <span>Остаток до: <strong class="det-balance-before"></strong></span>
                    <span>Проценты: <strong class="det-interest"></strong></span>
                    <span>Осн. долг (план): <strong class="det-principal-plan"></strong></span>
                    <span>Платёж (план): <strong class="det-payment-plan"></strong></span>
                    <span>Итого осн. долг: <strong class="det-total-principal"></strong></span>
                    <span>Дата оплаты: <strong class="det-payment-date"></strong></span>
                </div>
            </td>
        `;
        fragment.appendChild(tr);
        fragment.appendChild(detailsTr);
    }
    tbody.appendChild(fragment);
}

// ---------- Пересчёт графика ----------
function recalc() {
    loanAmount = parseFloat(amountInput.value) || 0;
    annualRate = parseFloat(rateInput.value) || 0;
    years = parseInt(yearsInput.value) || 20;
    monthlyRate = annualRate / 100 / 12;
    const newN = years * 12;

    if (newN !== N) {
        N = newN;
        extras = extras.slice(0, N);
        while (extras.length < N) extras.push(0);
        paidStatuses = paidStatuses.slice(0, N);
        while (paidStatuses.length < N) paidStatuses.push(false);
        paymentDates = paymentDates.slice(0, N);
        while (paymentDates.length < N) paymentDates.push('');
        buildTable();
    }

    const rows = tbody.querySelectorAll('tr[data-month]');
    const detailsRows = tbody.querySelectorAll('tr[data-details-for]');
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
        const scheduledPrincipal = balance / remainingMonths;
        const scheduledPayment = interest + scheduledPrincipal;
        let extra = extras[i] || 0;
        if (extra < 0) extra = 0;
        const maxExtra = Math.max(0, balance - scheduledPrincipal);
        const extraApplied = Math.min(extra, maxExtra);
        const totalPayment = scheduledPayment + extraApplied;
        const totalPrincipal = scheduledPrincipal + extraApplied;
        balance = balance - totalPrincipal;
        balance = Math.round(balance * 100) / 100;
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

        if (rows[i]) {
            const cells = rows[i].cells;
            cells[0].textContent = i + 1;
            cells[1].textContent = paymentDates[i] || '';
            cells[2].textContent = formatMoney(balanceBefore);
            cells[3].textContent = formatMoney(interest);
            cells[4].textContent = formatMoney(scheduledPrincipal);
            cells[5].textContent = formatMoney(scheduledPayment);
            cells[7].textContent = formatMoney(totalPayment);
            cells[8].textContent = formatMoney(totalPrincipal);
            cells[9].textContent = formatMoney(balance);
            const checkbox = cells[10].querySelector('.paid-checkbox');
            if (checkbox) checkbox.checked = paidStatuses[i];

            const detailsRow = detailsRows[i];
            if (detailsRow) {
                detailsRow.querySelector('.det-balance-before').textContent = formatMoney(balanceBefore);
                detailsRow.querySelector('.det-interest').textContent = formatMoney(interest);
                detailsRow.querySelector('.det-principal-plan').textContent = formatMoney(scheduledPrincipal);
                detailsRow.querySelector('.det-payment-plan').textContent = formatMoney(scheduledPayment);
                detailsRow.querySelector('.det-total-principal').textContent = formatMoney(totalPrincipal);
                detailsRow.querySelector('.det-payment-date').textContent = paymentDates[i] || '—';
            }
        }
    }

    document.getElementById('sum-total-payment').textContent = formatMoney(totalPaymentSum);
    document.getElementById('sum-total-interest').textContent = formatMoney(totalInterestSum);
    document.getElementById('sum-total-principal').textContent = formatMoney(totalPrincipalSum);
    document.getElementById('sum-total-extra').textContent = formatMoney(totalExtraSum);

    document.getElementById('fact-total-payment').textContent = formatMoney(factTotalPayment);
    document.getElementById('fact-total-interest').textContent = formatMoney(factTotalInterest);
    document.getElementById('fact-total-principal').textContent = formatMoney(factTotalPrincipal);
    document.getElementById('paid-months-count').textContent = paidMonthsCount;

    rows.forEach((row) => {
        const month = parseInt(row.dataset.month, 10);
        row.classList.toggle('paid', paidStatuses[month]);
    });

    rows.forEach((row) => {
        const month = parseInt(row.dataset.month, 10);
        const detailsRow = row.nextElementSibling;
        if (detailsRow && detailsRow.classList.contains('details-row')) {
            detailsRow.classList.toggle('active', expandedRows.has(month));
        }
    });
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
            // Параметры кредита тоже сохраняем, чтобы восстановить при загрузке
            amount: parseFloat(amountInput.value) || 0,
            rate: parseFloat(rateInput.value) || 0,
            years: parseInt(yearsInput.value) || 20,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (e) {
        console.error('Ошибка сохранения в Firebase:', e);
    }
}

// ---------- Загрузка данных из Firestore и подписка на изменения ----------
function teardownSync() {
    if (unsubscribeSchedule) {
        unsubscribeSchedule();
        unsubscribeSchedule = null;
    }
    isInitialized = false;
}

function initFirebaseListener() {
    if (!db) {
        isInitialized = true;
        return;
    }
    teardownSync();
    unsubscribeSchedule = db.collection(SCHEDULE_COLLECTION).doc(SCHEDULE_DOC)
        .onSnapshot((doc) => {
            if (doc.exists) {
                const data = doc.data();
                if (data.extras && Array.isArray(data.extras)) {
                    extras = data.extras.slice(0, N);
                    while (extras.length < N) extras.push(0);
                }
                if (data.paidStatuses && Array.isArray(data.paidStatuses)) {
                    paidStatuses = data.paidStatuses.slice(0, N);
                    while (paidStatuses.length < N) paidStatuses.push(false);
                }
                if (data.paymentDates && Array.isArray(data.paymentDates)) {
                    paymentDates = data.paymentDates.slice(0, N);
                    while (paymentDates.length < N) paymentDates.push('');
                }
                // Восстанавливаем параметры, если они есть
                if (data.amount !== undefined) amountInput.value = data.amount;
                if (data.rate !== undefined) rateInput.value = data.rate;
                if (data.years !== undefined) yearsInput.value = data.years;

                // Пересчитываем и обновляем таблицу
                isInitialized = true;
                buildTable();
                recalc();
            } else {
                // Если документа ещё нет, создаём с текущими значениями
                isInitialized = true;
                saveToFirebase();
            }
        }, (error) => {
            console.error('Ошибка получения данных из Firebase:', error);
            // В случае ошибки считаем, что инициализированы, и работаем локально
            isInitialized = true;
        });
}

// ---------- Обработчики событий ----------
tbody.addEventListener('input', function(e) {
    if (e.target.classList.contains('extra-input')) {
        const idx = parseInt(e.target.getAttribute('data-month'), 10);
        if (!isNaN(idx) && idx >= 0 && idx < N) {
            const val = parseFloat(e.target.value);
            extras[idx] = isNaN(val) ? 0 : Math.max(0, val);
            if (extras[idx] > 0 && !paymentDates[idx]) {
                paymentDates[idx] = formatDate(new Date());
            } else if (extras[idx] === 0 && !paidStatuses[idx]) {
                paymentDates[idx] = '';
            }
            recalc();
            saveToFirebase();
        }
    }
});

tbody.addEventListener('change', function(e) {
    if (e.target.classList.contains('paid-checkbox')) {
        const idx = parseInt(e.target.getAttribute('data-month'), 10);
        if (!isNaN(idx) && idx >= 0 && idx < N) {
            paidStatuses[idx] = e.target.checked;
            if (paidStatuses[idx] && !paymentDates[idx]) {
                paymentDates[idx] = formatDate(new Date());
            } else if (!paidStatuses[idx] && extras[idx] === 0) {
                paymentDates[idx] = '';
            }
            recalc();
            saveToFirebase();
        }
    }
});

tbody.addEventListener('click', function(e) {
    const tr = e.target.closest('tr[data-month]');
    if (tr && window.innerWidth <= 768) {
        if (e.target.tagName === 'INPUT') return;
        const month = parseInt(tr.dataset.month, 10);
        const detailsRow = tr.nextElementSibling;
        if (detailsRow && detailsRow.classList.contains('details-row')) {
            if (expandedRows.has(month)) {
                expandedRows.delete(month);
                detailsRow.classList.remove('active');
            } else {
                expandedRows.add(month);
                detailsRow.classList.add('active');
            }
        }
    }
});

amountInput.addEventListener('input', () => { recalc(); saveToFirebase(); });
rateInput.addEventListener('input', () => { recalc(); saveToFirebase(); });
yearsInput.addEventListener('input', () => { recalc(); saveToFirebase(); });

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
buildTable();
recalc();

if (!auth) {
    showApp(null);
    isInitialized = true;
} else {
    bindAuthUI();
    auth.onAuthStateChanged((user) => {
        if (user) {
            if (currentUid !== user.uid) {
                currentUid = user.uid;
                showApp(user.email || '');
                initFirebaseListener();
            }
        } else {
            currentUid = null;
            teardownSync();
            showLogin();
        }
    });
}
