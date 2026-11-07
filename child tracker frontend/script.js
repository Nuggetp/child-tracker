import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot, collection, query } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

const screens = [
    { path: "lock-screen.html", container: "screen-lock" },
    { path: "child-screen.html", container: "screen-child" },
    { path: "parent-screen.html", container: "screen-parent" }
];

const loadedScreens = await Promise.all(screens.map(async ({ path, container }) => {
    const response = await fetch(path);
    if (!response.ok) {
        throw new Error(`Failed to load ${path}: ${response.status}`);
    }
    return { container, markup: await response.text() };
}));

loadedScreens.forEach(({ container, markup }) => {
    document.getElementById(container).innerHTML = markup;
});

// Global configuration from environment
const appId = typeof __app_id !== 'undefined' ? __app_id : 'child-status-app-demo';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
    // Provide a dummy config if needed for local testing outside immersive, 
    // but in the actual environment it will be injected.
};

let app, db, auth;
try {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
} catch (e) {
    console.error("Firebase init failed:", e);
}

const LOCAL_TASKS_KEY = 'child-status-app.tasks';
const LOCAL_SCHEDULE_KEY = 'child-status-app.schedule';
const LOCAL_LOGS_KEY = 'child-status-app.logs';
const LOCAL_SUBJECTS_KEY = 'child-status-app.subjects';
const LOCAL_TEAMS_KEY = 'child-status-app.teams';

function readLocalItems(key) {
    try {
        const items = JSON.parse(localStorage.getItem(key) || '[]');
        if (!Array.isArray(items)) throw new Error(`Stored value for ${key} is not a list.`);
        return items;
    } catch (error) {
        console.error(`Could not load local data for ${key}.`, error);
        return [];
    }
}

function saveLocalItems(key, items) {
    try {
        localStorage.setItem(key, JSON.stringify(items));
    } catch (error) {
        console.error(`Could not save local data for ${key}.`, error);
        throw error;
    }
}

function createLocalId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Global State
let currentUserRole = null; // 'child' | 'parent'
let currentMood = null;
let subjectsList = readLocalItems(LOCAL_SUBJECTS_KEY);
let tasksList = readLocalItems(LOCAL_TASKS_KEY);
let logsList = readLocalItems(LOCAL_LOGS_KEY);
let scheduleList = readLocalItems(LOCAL_SCHEDULE_KEY);
let teamsData = (() => {
    try {
        return { pl: '', laliga: '', ...JSON.parse(localStorage.getItem(LOCAL_TEAMS_KEY) || '{}') };
    } catch (error) {
        console.error('Could not load favorite teams.', error);
        return { pl: '', laliga: '' };
    }
})();
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let parentCalendarMonth = new Date(calendarMonth);
let calendarSelectedDate = getLocalDateString(new Date());
let parentCalendarSelectedDate = calendarSelectedDate;

// Listeners for cleanup
let subjectsUnsub = null;
let tasksUnsub = null;
let logsUnsub = null;
let scheduleUnsub = null;
let teamsUnsub = null;

// Passwords (Hardcoded per prompt)
const PIN_CHILD = "2110";
const PIN_PARENT = "0909";

// --- DOM Elements ---
const views = {
    login: document.getElementById('view-login'),
    childDash: document.getElementById('view-child-dash'),
    logInfo: document.getElementById('view-log-info'),
    settings: document.getElementById('view-settings'),
    calendar: document.getElementById('view-calendar'),
    parentDash: document.getElementById('view-parent-dash')
};
const nav = document.getElementById('top-nav');
const navTitle = document.getElementById('nav-title');
const btnBack = document.getElementById('btn-back');
const btnLogout = document.getElementById('btn-logout');

// --- Constants & Data ---
const PL_TEAMS = ["Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton", "Chelsea", "Crystal Palace", "Everton", "Fulham", "Ipswich Town", "Leicester City", "Liverpool", "Manchester City", "Manchester United", "Newcastle United", "Nottingham Forest", "Southampton", "Tottenham Hotspur", "West Ham United", "Wolverhampton Wanderers"];
const LALIGA_TEAMS = ["Alavés", "Athletic Club", "Atlético Madrid", "Barcelona", "Celta Vigo", "Espanyol", "Getafe", "Girona", "Las Palmas", "Leganés", "Mallorca", "Osasuna", "Rayo Vallecano", "Real Betis", "Real Madrid", "Real Sociedad", "Sevilla", "Valencia", "Valladolid", "Villarreal"];

// Populate Selects
const plSelect = document.getElementById('input-pl-team');
const laligaSelect = document.getElementById('input-laliga-team');
PL_TEAMS.forEach(team => plSelect.add(new Option(team, team)));
LALIGA_TEAMS.forEach(team => laligaSelect.add(new Option(team, team)));
plSelect.value = teamsData.pl;
laligaSelect.value = teamsData.laliga;

// --- Modal Utility ---
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modal-title');
const modalMsg = document.getElementById('modal-msg');
const modalInput = document.getElementById('modal-input');
const modalCancel = document.getElementById('modal-cancel');
const modalOk = document.getElementById('modal-ok');

let modalResolve = null;

function showModal(title, msg, type = 'alert') {
    return new Promise((resolve) => {
        modalTitle.textContent = title;
        modalMsg.textContent = msg;
        modalInput.value = '';

        if (type === 'prompt') {
            modalInput.classList.remove('hidden');
            modalCancel.classList.remove('hidden');
            modalInput.focus();
        } else {
            modalInput.classList.add('hidden');
            modalCancel.classList.add('hidden');
        }

        modal.classList.remove('hidden');
        modalResolve = resolve;
    });
}

// --- Schedule Handlers ---

// Toggle Form Visibility
document.getElementById('show-event-form').addEventListener('click', () => {
    document.getElementById('event-form-container').classList.toggle('hidden');
    document.getElementById('routine-form-container').classList.add('hidden');
});
document.getElementById('show-routine-form').addEventListener('click', () => {
    document.getElementById('routine-form-container').classList.toggle('hidden');
    document.getElementById('event-form-container').classList.add('hidden');
});

// Add Specific Event
document.getElementById('btn-add-event').addEventListener('click', async () => {
    const date = document.getElementById('event-date').value;
    const time = document.getElementById('event-time').value;
    const type = document.getElementById('event-type').value;
    const title = document.getElementById('event-title').value.trim();

    if (!date || !time || !title) {
        await showModal("Missing Info", "Please provide a date, time, and title.", "alert");
        return;
    }

    try {
        const event = { isRoutine: false, date, time, type, title, timestamp: Date.now() };
        if (auth?.currentUser && db) {
            const scheduleRef = collection(db, 'artifacts', appId, 'public', 'data', 'schedule');
            await addDoc(scheduleRef, event);
        } else {
            scheduleList.push({ ...event, id: createLocalId() });
            saveLocalItems(LOCAL_SCHEDULE_KEY, scheduleList);
        }
        document.getElementById('event-time').value = '';
        document.getElementById('event-title').value = '';
        document.getElementById('event-form-container').classList.add('hidden');
        renderSchedule();
    } catch (error) {
        console.error("Error adding event", error);
        await showModal("Error", "Could not save this event.", "alert");
    }
});

// Add Weekly Routine
document.getElementById('btn-add-routine').addEventListener('click', async () => {
    const day = parseInt(document.getElementById('routine-day').value);
    const time = document.getElementById('routine-time').value;
    const title = document.getElementById('routine-title').value.trim();

    if (!time || !title) {
        await showModal("Missing Info", "Please provide a time and activity name.", "alert");
        return;
    }

    try {
        const routine = { isRoutine: true, day, time, type: 'routine', title, timestamp: Date.now() };
        if (auth?.currentUser && db) {
            const scheduleRef = collection(db, 'artifacts', appId, 'public', 'data', 'schedule');
            await addDoc(scheduleRef, routine);
        } else {
            scheduleList.push({ ...routine, id: createLocalId() });
            saveLocalItems(LOCAL_SCHEDULE_KEY, scheduleList);
        }
        document.getElementById('routine-time').value = '';
        document.getElementById('routine-title').value = '';
        document.getElementById('routine-form-container').classList.add('hidden');
        renderSchedule();
    } catch (error) {
        console.error("Error adding routine", error);
        await showModal("Error", "Could not save this weekly routine.", "alert");
    }
});

function getLocalDateString(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getLogDateKey(log) {
    if (log.dayKey) return log.dayKey;
    if (Number.isFinite(Number(log.timestamp))) {
        return getLocalDateString(new Date(Number(log.timestamp)));
    }
    const parsedDate = new Date(log.dateStr);
    return Number.isNaN(parsedDate.getTime()) ? '' : getLocalDateString(parsedDate);
}

function renderCalendar() {
    renderMonthCalendar(
        calendarMonth,
        'calendar-month',
        'month-calendar-grid',
        'calendar-prev',
        'calendar-next',
        calendarSelectedDate,
        (dateString, date) => {
            calendarSelectedDate = dateString;
            if (date.getMonth() !== calendarMonth.getMonth() || date.getFullYear() !== calendarMonth.getFullYear()) {
                calendarMonth = new Date(date.getFullYear(), date.getMonth(), 1);
            }
            renderCalendar();
        }
    );
    renderSelectedDaySchedule('calendar-day-heading', 'calendar-day-schedule', calendarSelectedDate, true);
}

function renderMonthCalendar(month, headingId, gridId, previousId, nextId, selectedDate, onSelectDate) {
    const heading = document.getElementById(headingId);
    const grid = document.getElementById(gridId);
    const prevButton = document.getElementById(previousId);
    const nextButton = document.getElementById(nextId);
    if (!heading || !grid || !prevButton || !nextButton) return;

    heading.textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const now = new Date();
    const monthOffset = (month.getFullYear() - now.getFullYear()) * 12 + month.getMonth() - now.getMonth();
    prevButton.disabled = monthOffset <= -2;
    nextButton.disabled = monthOffset >= 2;
    prevButton.classList.toggle('opacity-40', prevButton.disabled);
    nextButton.classList.toggle('opacity-40', nextButton.disabled);

    const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
    const firstVisibleDate = new Date(firstOfMonth);
    firstVisibleDate.setDate(firstVisibleDate.getDate() - firstVisibleDate.getDay());
    grid.replaceChildren();
    for (let index = 0; index < 42; index++) {
        const date = new Date(firstVisibleDate);
        date.setDate(firstVisibleDate.getDate() + index);
        const dateString = getLocalDateString(date);
        const isCurrentMonth = date.getMonth() === month.getMonth();
        const isToday = dateString === getLocalDateString(now);
        const isSelected = dateString === selectedDate;
        const dayCell = document.createElement('button');
        dayCell.type = 'button';
        dayCell.className = `month-calendar-day calendar-day-button${isCurrentMonth ? '' : ' outside-month'}${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`;
        dayCell.setAttribute('aria-label', date.toLocaleDateString(undefined, {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
        }));
        dayCell.setAttribute('aria-pressed', String(isSelected));
        dayCell.addEventListener('click', () => onSelectDate(dateString, date));

        const dayNumber = document.createElement('span');
        dayNumber.className = 'month-calendar-day-number';
        dayNumber.textContent = String(date.getDate());
        dayCell.appendChild(dayNumber);

        const events = scheduleList
            .filter(event => event.isRoutine !== false
                ? Number(event.day) === date.getDay()
                : event.date === dateString)
            .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

        events.slice(0, 3).forEach(event => {
            const eventLabel = document.createElement('span');
            eventLabel.className = 'month-calendar-event';
            eventLabel.title = `${event.time || ''} ${event.title}`.trim();
            eventLabel.textContent = `${event.time ? `${event.time} ` : ''}${event.title}`;
            dayCell.appendChild(eventLabel);
        });
        if (events.length > 3) {
            const more = document.createElement('span');
            more.className = 'month-calendar-event';
            more.textContent = `+${events.length - 3} more`;
            dayCell.appendChild(more);
        }

        grid.appendChild(dayCell);
    }
}

function getScheduleEventsForDate(dateString) {
    const date = new Date(`${dateString}T00:00:00`);
    return scheduleList
        .filter(event => event.isRoutine !== false
            ? Number(event.day) === date.getDay()
            : event.date === dateString)
        .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

function renderSelectedDaySchedule(headingId, containerId, dateString, canDelete) {
    const heading = document.getElementById(headingId);
    const container = document.getElementById(containerId);
    if (!heading || !container) return;

    const date = new Date(`${dateString}T00:00:00`);
    heading.textContent = `Schedule for ${date.toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric'
    })}`;
    container.replaceChildren();

    const events = getScheduleEventsForDate(dateString);
    if (events.length === 0) {
        const emptyMessage = document.createElement('p');
        emptyMessage.className = 'text-sm text-gray-400';
        emptyMessage.textContent = 'No schedule items for this day.';
        container.appendChild(emptyMessage);
        return;
    }

    const typeLabels = {
        class: 'Class',
        pl: 'Premier League',
        laliga: 'La Liga',
        f1: 'F1 Race',
        routine: 'Weekly routine',
        other: 'Activity'
    };
    events.forEach(event => {
        const row = document.createElement('div');
        row.className = 'flex items-start justify-between gap-3 p-3 bg-gray-50 rounded-xl';
        const details = document.createElement('div');
        details.className = 'min-w-0';
        const title = document.createElement('div');
        title.className = 'font-semibold text-gray-800';
        title.textContent = event.title || 'Untitled event';
        const metadata = document.createElement('div');
        metadata.className = 'text-xs text-gray-500 mt-1';
        const eventType = typeLabels[event.type] || 'Activity';
        const weeklyLabel = event.isRoutine !== false && event.type !== 'routine' ? ' · Weekly' : '';
        metadata.textContent = `${event.time || 'Time not set'} · ${eventType}${weeklyLabel}`;
        details.append(title, metadata);
        row.appendChild(details);

        if (canDelete && event.id) {
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'btn-del-schedule shrink-0 text-red-500 hover:text-red-700 p-1';
            deleteButton.dataset.id = event.id;
            deleteButton.setAttribute('aria-label', `Delete ${event.title || 'schedule item'}`);
            deleteButton.innerHTML = '<i class="fas fa-trash-alt" aria-hidden="true"></i>';
            row.appendChild(deleteButton);
        }
        container.appendChild(row);
    });
}

document.getElementById('calendar-prev').addEventListener('click', () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    renderCalendar();
});
document.getElementById('calendar-next').addEventListener('click', () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    renderCalendar();
});
document.getElementById('parent-calendar-prev').addEventListener('click', () => {
    parentCalendarMonth = new Date(parentCalendarMonth.getFullYear(), parentCalendarMonth.getMonth() - 1, 1);
    renderParentSchedule();
});
document.getElementById('parent-calendar-next').addEventListener('click', () => {
    parentCalendarMonth = new Date(parentCalendarMonth.getFullYear(), parentCalendarMonth.getMonth() + 1, 1);
    renderParentSchedule();
});

function renderSchedule() {
    renderCalendar();
    renderParentSchedule();
}

document.getElementById('calendar-day-schedule').addEventListener('click', async event => {
    const button = event.target.closest('.btn-del-schedule');
    if (!button) return;
    const id = button.dataset.id;
    try {
        if (auth?.currentUser && db) {
            await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'schedule', id));
        } else {
            scheduleList = scheduleList.filter(item => item.id !== id);
            saveLocalItems(LOCAL_SCHEDULE_KEY, scheduleList);
            renderSchedule();
        }
    } catch (error) {
        console.error('Error deleting schedule event', error);
        await showModal('Error', 'Could not delete this schedule item.', 'alert');
    }
});

// --- Parent View Handlers ---
function getMoodEmoji(moodText) {
    const map = {
        'Terrible': '😫', 'Bad': '😕', 'Okay': '😐', 'Good': '🙂', 'Great': '😄'
    };
    return map[moodText] || '😐';
}

function renderParentLogs() {
    const container = document.getElementById('parent-logs-container');
    const count = document.getElementById('parent-logs-count');

    container.innerHTML = '';
    count.textContent = `${logsList.length} logs found`;

    if (logsList.length === 0) {
        container.innerHTML = '<div class="text-center p-8 bg-white rounded-2xl shadow-sm text-gray-500">No logs found yet.</div>';
        return;
    }

    // Sort logs by timestamp descending (newest first)
    const sortedLogs = [...logsList].sort((a, b) => b.timestamp - a.timestamp);

    sortedLogs.forEach(log => {
        const dateObj = new Date(log.timestamp);
        const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const card = document.createElement('div');
        card.className = "bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden";

        let testSection = '';
        if (log.testSubject || log.testScore) {
            testSection = `
                <div class="mt-3 bg-indigo-50 p-3 rounded-xl border border-indigo-100 flex justify-between items-center">
                    <div>
                        <div class="text-xs text-indigo-500 font-bold uppercase">Test Entry</div>
                        <div class="font-semibold text-indigo-900">${log.testSubject || 'Subject N/A'}</div>
                    </div>
                    <div class="text-right">
                        <div class="text-lg font-bold text-indigo-700">${log.testScore || '-'}</div>
                        <div class="text-xs text-indigo-500">${log.testResult || '-'}</div>
                    </div>
                </div>
            `;
        }

        card.innerHTML = `
            <div class="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                <div>
                    <div class="font-bold text-gray-800">${log.dateStr}</div>
                    <div class="text-xs text-gray-500">${timeStr}</div>
                </div>
                <div class="flex items-center gap-2 bg-white px-3 py-1 rounded-full shadow-sm">
                    <span class="text-2xl">${getMoodEmoji(log.mood)}</span>
                    <span class="text-sm font-semibold text-gray-700">${log.mood}</span>
                </div>
            </div>
            <div class="p-4 space-y-4">
                <div class="grid grid-cols-4 gap-2 text-center">
                    <div class="bg-blue-50 p-2 rounded-xl">
                        <div class="text-xs text-blue-500 mb-1">Free</div>
                        <div class="font-bold text-blue-700">${log.freeTime}/10</div>
                    </div>
                    <div class="bg-red-50 p-2 rounded-xl">
                        <div class="text-xs text-red-500 mb-1">Stress</div>
                        <div class="font-bold text-red-700">${log.stress}/10</div>
                    </div>
                    <div class="bg-emerald-50 p-2 rounded-xl">
                        <div class="text-xs text-emerald-500 mb-1">Screen</div>
                        <div class="font-bold text-emerald-700">${log.screenTime || 0}h</div>
                    </div>
                    <div class="bg-purple-50 p-2 rounded-xl">
                        <div class="text-xs text-purple-500 mb-1">Sleep</div>
                        <div class="font-bold text-purple-700">${log.sleepTime || '-'}</div>
                    </div>
                </div>

                ${testSection}

                <div class="space-y-3 pt-2">
                    ${log.interesting ? `
                    <div>
                        <div class="text-xs font-bold text-gray-400 mb-1 uppercase tracking-wider">Most Interesting</div>
                        <p class="text-sm text-gray-700 bg-gray-50 p-3 rounded-xl">${log.interesting}</p>
                    </div>` : ''}

                    ${log.happened ? `
                    <div>
                        <div class="text-xs font-bold text-gray-400 mb-1 uppercase tracking-wider">Happened Today</div>
                        <p class="text-sm text-gray-700 bg-gray-50 p-3 rounded-xl">${log.happened}</p>
                    </div>` : ''}
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

function renderParentSchedule() {
    renderMonthCalendar(
        parentCalendarMonth,
        'parent-calendar-month',
        'parent-calendar-grid',
        'parent-calendar-prev',
        'parent-calendar-next',
        parentCalendarSelectedDate,
        (dateString, date) => {
            parentCalendarSelectedDate = dateString;
            if (date.getMonth() !== parentCalendarMonth.getMonth() || date.getFullYear() !== parentCalendarMonth.getFullYear()) {
                parentCalendarMonth = new Date(date.getFullYear(), date.getMonth(), 1);
            }
            renderParentSchedule();
        }
    );
    renderSelectedDaySchedule(
        'parent-calendar-day-heading',
        'parent-calendar-day-schedule',
        parentCalendarSelectedDate,
        false
    );
}


// --- Firebase Sync Logic ---
function startDataSync() {
    if (!auth?.currentUser || !db) {
        renderSubjects();
        renderTasks();
        renderSchedule();
        renderParentLogs();
        renderParentSchedule();
        return;
    }
    cleanupListeners();

    const baseDocRef = doc(db, 'artifacts', appId, 'public', 'data');

    // 1. Subjects
    const qSubjects = query(collection(baseDocRef, 'subjects'));
    subjectsUnsub = onSnapshot(qSubjects, (snapshot) => {
        subjectsList = [];
        snapshot.forEach(doc => {
            subjectsList.push({ id: doc.id, ...doc.data() });
        });
        renderSubjects();
    }, (err) => console.error(err));

    // 2. Tasks
    const qTasks = query(collection(baseDocRef, 'tasks'));
    tasksUnsub = onSnapshot(qTasks, (snapshot) => {
        tasksList = [];
        snapshot.forEach(doc => {
            tasksList.push({ id: doc.id, ...doc.data() });
        });
        // Sort incomplete first, then by timestamp
        tasksList.sort((a, b) => {
            if (a.completed === b.completed) return (a.timestamp || 0) - (b.timestamp || 0);
            return a.completed ? 1 : -1;
        });
        renderTasks();
    }, (err) => console.error(err));

    // 3. Schedule
    const qSchedule = query(collection(baseDocRef, 'schedule'));
    scheduleUnsub = onSnapshot(qSchedule, (snapshot) => {
        scheduleList = [];
        snapshot.forEach(doc => {
            scheduleList.push({ id: doc.id, ...doc.data() });
        });
        renderSchedule();
        renderParentSchedule();
    }, (err) => console.error(err));

    // 4. Logs
    const qLogs = query(collection(baseDocRef, 'logs'));
    logsUnsub = onSnapshot(qLogs, (snapshot) => {
        logsList = [];
        snapshot.forEach(doc => {
            logsList.push({ id: doc.id, ...doc.data() });
        });
        if (currentUserRole === 'parent') {
            renderParentLogs();
        }
    }, (err) => console.error(err));

    // 5. Teams Preference
    const teamsRef = doc(baseDocRef, 'settings', 'teams');
    teamsUnsub = onSnapshot(teamsRef, (docSnap) => {
        if (docSnap.exists()) {
            teamsData = docSnap.data();
            const plInput = document.getElementById('input-pl-team');
            const laligaInput = document.getElementById('input-laliga-team');
            if (plInput) plInput.value = teamsData.pl || '';
            if (laligaInput) laligaInput.value = teamsData.laliga || '';
        }
    }, (err) => console.error(err));
}

function cleanupListeners() {
    if (subjectsUnsub) subjectsUnsub();
    if (tasksUnsub) tasksUnsub();
    if (logsUnsub) logsUnsub();
    if (scheduleUnsub) scheduleUnsub();
    if (teamsUnsub) teamsUnsub();
    subjectsUnsub = null;
    tasksUnsub = null;
    logsUnsub = null;
    scheduleUnsub = null;
    teamsUnsub = null;
}

// --- Navigation Helper ---
function showView(viewElement, title = "", showNav = true, showBack = true) {
    Object.values(views).forEach(v => v.classList.add('hidden'));
    viewElement.classList.remove('hidden');

    if (showNav) {
        nav.classList.remove('hidden');
        navTitle.textContent = title;
        if (showBack) btnBack.classList.remove('hidden');
        else btnBack.classList.add('hidden');
    } else {
        nav.classList.add('hidden');
    }
}

// --- Modal Events ---
modalCancel.addEventListener('click', () => {
    modal.classList.add('hidden');
    if (modalResolve) modalResolve(null);
});

modalOk.addEventListener('click', () => {
    modal.classList.add('hidden');
    const val = modalInput.classList.contains('hidden') ? true : modalInput.value;
    if (modalResolve) modalResolve(val);
});

// --- Login Events ---
document.getElementById('login-child').addEventListener('click', async () => {
    const pin = await showModal("Child Login", "Enter Child PIN:", "prompt");
    if (pin === PIN_CHILD) {
        currentUserRole = 'child';
        startDataSync();
        showView(views.childDash, "Child Dashboard", true, false);
    } else if (pin !== null) {
        showModal("Error", "Incorrect PIN", "alert");
    }
});

document.getElementById('login-parent').addEventListener('click', async () => {
    const pin = await showModal("Parent Login", "Enter Parent PIN:", "prompt");
    if (pin === PIN_PARENT) {
        currentUserRole = 'parent';
        startDataSync();
        renderParentLogs();
        renderParentSchedule();
        showView(views.parentDash, "Parent Dashboard", true, false);
    } else if (pin !== null) {
        showModal("Error", "Incorrect PIN", "alert");
    }
});

// --- Dashboard Navigation Events ---
document.getElementById('btn-goto-log').addEventListener('click', () => {
    const select = document.getElementById('input-test-subject');
    select.innerHTML = '<option value="">Select a subject...</option>';
    subjectsList.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.name;
        opt.textContent = s.name;
        select.appendChild(opt);
    });
    const todaysLog = logsList.find(log => getLogDateKey(log) === getLocalDateString(new Date()));
    const form = document.getElementById('log-form');
    form.reset();
    currentMood = todaysLog?.mood || null;
    document.querySelectorAll('.mood-btn').forEach(button => {
        button.classList.toggle('selected', button.dataset.val === currentMood);
    });
    if (todaysLog) {
        document.getElementById('input-free').value = todaysLog.freeTime ?? '5';
        document.getElementById('input-stress').value = todaysLog.stress ?? '5';
        document.getElementById('input-screen').value = todaysLog.screenTime || '';
        document.getElementById('input-sleep').value = todaysLog.sleepTime || '';
        document.getElementById('input-test-subject').value = todaysLog.testSubject || '';
        document.getElementById('input-test-score').value = todaysLog.testScore || '';
        document.getElementById('input-test-result').value = todaysLog.testResult || '';
        document.getElementById('input-interesting').value = todaysLog.interesting || '';
        document.getElementById('input-happened').value = todaysLog.happened || '';
    }
    freeVal.textContent = `${document.getElementById('input-free').value}/10`;
    stressVal.textContent = `${document.getElementById('input-stress').value}/10`;
    document.getElementById('btn-save-log').textContent = todaysLog ? "Update Today's Log" : "Save Today's Log";
    document.getElementById('btn-goto-log-label').textContent = todaysLog ? "Edit Today's Log" : "Log Today's Info";
    showView(views.logInfo, "Log Today's Info", true, true);
});

document.getElementById('btn-goto-calendar').addEventListener('click', () => {
    showView(views.calendar, "Calendar & Tasks", true, true);
});

document.getElementById('btn-goto-settings').addEventListener('click', () => {
    showView(views.settings, "Manage Subjects", true, true);
    renderSubjects();
    loadCurrentTeams();
});

btnBack.addEventListener('click', () => {
    if (currentUserRole === 'child') showView(views.childDash, "Child Dashboard", true, false);
    else showView(views.parentDash, "Parent Dashboard", true, false);
});

btnLogout.addEventListener('click', () => {
    currentUserRole = null;
    cleanupListeners();
    showView(views.login, "", false, false);
});

// --- Log Form Interactivity ---
document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('selected'));
        e.currentTarget.classList.add('selected');
        currentMood = e.currentTarget.getAttribute('data-val');
    });
});

const inputFree = document.getElementById('input-free');
const freeVal = document.getElementById('free-val');
inputFree.addEventListener('input', (e) => freeVal.textContent = `${e.target.value}/10`);

const inputStress = document.getElementById('input-stress');
const stressVal = document.getElementById('stress-val');
inputStress.addEventListener('input', (e) => stressVal.textContent = `${e.target.value}/10`);

document.getElementById('log-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentMood) {
        await showModal("Missing Info", "Please select your mood today.", "alert");
        return;
    }

    const dayKey = getLocalDateString(new Date());
    const existingLog = logsList.find(log => getLogDateKey(log) === dayKey);
    const logData = {
        dayKey,
        mood: currentMood,
        freeTime: inputFree.value,
        stress: inputStress.value,
        screenTime: document.getElementById('input-screen').value,
        sleepTime: document.getElementById('input-sleep').value,
        testSubject: document.getElementById('input-test-subject').value,
        testScore: document.getElementById('input-test-score').value,
        testResult: document.getElementById('input-test-result').value,
        interesting: document.getElementById('input-interesting').value,
        happened: document.getElementById('input-happened').value,
        timestamp: Date.now(),
        dateStr: new Date().toLocaleDateString()
    };

    try {
        if (auth?.currentUser && db) {
            const logsRef = collection(db, 'artifacts', appId, 'public', 'data', 'logs');
            if (existingLog?.id) {
                await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'logs', existingLog.id), logData);
                logsList = logsList.map(log => log.id === existingLog.id ? { ...log, ...logData } : log);
            } else {
                const logRef = doc(db, 'artifacts', appId, 'public', 'data', 'logs', dayKey);
                const storedLog = await getDoc(logRef);
                if (storedLog.exists()) {
                    await updateDoc(logRef, logData);
                    const cachedLog = logsList.some(log => log.id === storedLog.id);
                    logsList = cachedLog
                        ? logsList.map(log => log.id === storedLog.id ? { ...log, ...logData } : log)
                        : [...logsList, { id: storedLog.id, ...logData }];
                } else {
                    await setDoc(logRef, logData);
                    logsList.push({ id: dayKey, ...logData });
                }
            }
        } else {
            if (existingLog) {
                logsList = logsList.map(log => log.id === existingLog.id ? { ...log, ...logData } : log);
            } else {
                logsList.push({ id: dayKey, ...logData });
            }
            saveLocalItems(LOCAL_LOGS_KEY, logsList);
        }
        renderParentLogs();
        await showModal("Success", "Today's log saved successfully!", "alert");
        showView(views.childDash, "Child Dashboard", true, false);
        e.target.reset();
        document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('selected'));
        currentMood = null;
        freeVal.textContent = "5/10";
        stressVal.textContent = "5/10";
        document.getElementById('btn-save-log').textContent = "Save Today's Log";
        document.getElementById('btn-goto-log-label').textContent = "Edit Today's Log";
    } catch (err) {
        console.error(err);
        showModal("Error", "Failed to save log.", "alert");
    }
});

// --- Subjects Logic ---
function renderSubjects() {
    const list = document.getElementById('subjects-list');
    list.innerHTML = '';
    subjectsList.forEach(sub => {
        const li = document.createElement('li');
        li.className = "flex justify-between items-center p-3 bg-gray-50 rounded-xl border border-gray-100";
        const name = document.createElement('span');
        name.className = 'font-medium text-gray-700';
        name.textContent = sub.name;
        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'text-red-400 hover:text-red-600 p-1 btn-del-subject';
        removeButton.dataset.id = sub.id;
        removeButton.innerHTML = '<i class="fas fa-trash"></i>';
        li.append(name, removeButton);
        list.appendChild(li);
    });

    document.querySelectorAll('.btn-del-subject').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            try {
                if (auth?.currentUser && db) {
                    await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'subjects', id));
                } else {
                    subjectsList = subjectsList.filter(subject => subject.id !== id);
                    saveLocalItems(LOCAL_SUBJECTS_KEY, subjectsList);
                    renderSubjects();
                }
            } catch (error) {
                console.error('Error deleting subject', error);
                await showModal('Error', 'Could not remove this subject.', 'alert');
            }
        });
    });
}

document.getElementById('btn-add-subject').addEventListener('click', async () => {
    const input = document.getElementById('new-subject-input');
    const name = input.value.trim();
    if (!name) return;
    try {
        if (auth?.currentUser && db) {
            await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'subjects'), { name, timestamp: Date.now() });
        } else {
            subjectsList.push({ id: createLocalId(), name, timestamp: Date.now() });
            saveLocalItems(LOCAL_SUBJECTS_KEY, subjectsList);
            renderSubjects();
        }
        input.value = '';
    } catch (error) {
        console.error('Error adding subject', error);
        await showModal('Error', 'Could not save this subject.', 'alert');
    }
});

async function fetchApiJson(url) {
    let response;
    
    // Add your Render URL here!
    const renderUrl = "https://child-tracker-r137.onrender.com/" + url; 
    
    try {
        // Change it to fetch the new renderUrl
        response = await fetch(renderUrl); 
    } catch (error) {
        if (error instanceof TypeError) {
            throw new Error('Cannot reach the schedule service. Ensure your Render server is live.');
        }
        throw error;
    }
    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `API request failed (${response.status}): ${url}`);
    }
    return response.json();
}

function normalizeTeamName(name) {
    return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchLeagueTeams(league) {
    const data = await fetchApiJson(`/api/football/teams?league=${encodeURIComponent(league)}`);
    const teams = data.sports?.[0]?.leagues?.[0]?.teams?.map(entry => entry.team) || [];
    if (!teams.length) throw new Error(`No teams returned for ${league}.`);
    return teams;
}

async function loadCurrentTeams() {
    const [plResult, laligaResult] = await Promise.allSettled([
        fetchLeagueTeams('eng.1'),
        fetchLeagueTeams('esp.1')
    ]);

    for (const [result, select, fallback] of [
        [plResult, plSelect, PL_TEAMS],
        [laligaResult, laligaSelect, LALIGA_TEAMS]
    ]) {
        const selected = select.value || (select === plSelect ? teamsData.pl : teamsData.laliga);
        const teams = result.status === 'fulfilled'
            ? result.value.map(team => team.displayName || team.name).sort((a, b) => a.localeCompare(b))
            : fallback;
        select.replaceChildren(new Option(select === plSelect ? 'Select PL Team...' : 'Select La Liga Team...', ''));
        teams.forEach(team => select.add(new Option(team, team)));
        select.value = teams.includes(selected) ? selected : '';
    }

    const errors = [plResult, laligaResult]
        .filter(result => result.status === 'rejected')
        .map(result => result.reason.message);
    if (errors.length) {
        console.error('Could not refresh team choices from ESPN.', errors);
        await showModal('Team list unavailable', 'Could not refresh current team choices from ESPN. You can still choose from the saved list.', 'alert');
    }
}

async function fetchFootballFixtures(league, selectedTeam, source, type) {
    if (!selectedTeam) return [];
    const teams = await fetchLeagueTeams(league);
    const selectedKey = normalizeTeamName(selectedTeam);
    const team = teams.find(candidate => [
        candidate.displayName,
        candidate.name,
        candidate.nickname,
        candidate.shortDisplayName
    ].some(name => name && normalizeTeamName(name) === selectedKey));
    if (!team) throw new Error(`Could not find ${selectedTeam} in the current ${league} team list.`);

    const [teamSchedule, todayScoreboard] = await Promise.all([
        fetchApiJson(`/api/football/team-schedule?league=${encodeURIComponent(league)}&teamId=${encodeURIComponent(team.id)}`),
        fetchApiJson(`/api/football/scoreboard?league=${encodeURIComponent(league)}&date=${getLocalDateString(new Date())}`)
    ]);
    const today = getLocalDateString(new Date());
    const limit = new Date();
    limit.setDate(limit.getDate() + 90);
    const limitString = getLocalDateString(limit);
    const calendarDates = todayScoreboard.leagues?.[0]?.calendar || [];
    const datesToFetch = [...new Set(calendarDates
        .map(date => date.slice(0, 10))
        .filter(date => date >= today && date <= limitString))];
    if (!datesToFetch.includes(today)) datesToFetch.unshift(today);

    const scoreboards = [];
    for (let index = 0; index < datesToFetch.length; index += 6) {
        const dateBatch = datesToFetch.slice(index, index + 6);
        const batch = await Promise.all(dateBatch.map(date => date === today
            ? todayScoreboard
            : fetchApiJson(`/api/football/scoreboard?league=${encodeURIComponent(league)}&date=${date}`)));
        scoreboards.push(...batch);
    }

    const belongsToTeam = event => event.competitions?.[0]?.competitors
        ?.some(competitor => String(competitor.team?.id || competitor.id) === String(team.id));
    const makeScheduleEvent = event => {
        const competition = event.competitions?.[0];
        const kickoff = new Date(event.date);
        const competitors = competition?.competitors || [];
        const scores = competitors.map(competitor => {
            const score = competitor.score;
            if (typeof score === 'string' || typeof score === 'number') return String(score);
            return score?.displayValue ?? (score?.value === undefined ? '' : String(score.value));
        }).filter(Boolean);
        const completed = competition?.status?.type?.state === 'post';
        const title = completed && scores.length >= 2
            ? `${event.name} (${scores.join('-')})`
            : event.name;
        return {
            id: `auto-${source}-${event.id}`,
            isRoutine: false,
            isAutoSync: true,
            source,
            date: getLocalDateString(kickoff),
            time: kickoff.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
            type,
            title,
            venue: competition?.venue?.fullName || '',
            timestamp: kickoff.getTime()
        };
    };

    const recentResults = (teamSchedule.events || [])
        .filter(event => event.date && new Date(event.date) < new Date() && event.competitions?.[0]?.status?.type?.state === 'post')
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 5);
    const upcomingFixtures = scoreboards.flatMap(scoreboard => scoreboard.events || [])
        .filter(event => event.date
            && getLocalDateString(new Date(event.date)) >= today
            && belongsToTeam(event));
    const fixturesById = new Map([...recentResults, ...upcomingFixtures]
        .map(event => [event.id, event]));
    return [...fixturesById.values()].map(makeScheduleEvent);
}

async function fetchF1Schedule() {
    const year = new Date().getFullYear();
    let data = await fetchApiJson(`/api/f1/schedule?year=${year}`);
    let races = data.MRData?.RaceTable?.Races || [];
    const sessions = [
        ['FirstPractice', 'Practice 1'],
        ['SecondPractice', 'Practice 2'],
        ['ThirdPractice', 'Practice 3'],
        ['SprintQualifying', 'Sprint Qualifying'],
        ['Sprint', 'Sprint'],
        ['Qualifying', 'Qualifying'],
        [null, 'Race']
    ];
    const now = new Date();
    const hasFutureSession = race => sessions.some(([field]) => {
        const session = field ? race[field] : race;
        return session?.date && new Date(`${session.date}T${session.time || '12:00:00Z'}`) >= now;
    });
    if (!races.some(hasFutureSession)) {
        data = await fetchApiJson(`/api/f1/schedule?year=${year + 1}`);
        races = data.MRData?.RaceTable?.Races || [];
    }
    return races.flatMap(race => sessions.flatMap(([field, label]) => {
        const session = field ? race[field] : race;
        if (!session?.date) return [];
        const sessionDate = new Date(`${session.date}T${session.time || '12:00:00Z'}`);
        if (sessionDate < now) return [];
        const source = 'jolpi-f1';
        const sessionId = field || 'Race';
        return [{
            id: `auto-${source}-${race.round}-${sessionId}`,
            isRoutine: false,
            isAutoSync: true,
            source,
            date: session.date,
            time: sessionDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
            type: 'f1',
            title: `${label} - ${race.raceName}`,
            venue: race.Circuit?.circuitName || '',
            timestamp: sessionDate.getTime()
        }];
    }));
}

async function syncOnlineSchedules(plTeam, laligaTeam) {
    const sources = [
        {
            source: 'espn-pl',
            request: () => fetchFootballFixtures('eng.1', plTeam, 'espn-pl', 'pl')
        },
        {
            source: 'espn-laliga',
            request: () => fetchFootballFixtures('esp.1', laligaTeam, 'espn-laliga', 'laliga')
        },
        { source: 'jolpi-f1', request: fetchF1Schedule }
    ];
    const results = await Promise.all(sources.map(async ({ source, request }) => {
        try {
            return { source, events: await request() };
        } catch (error) {
            return { source, error };
        }
    }));
    const succeeded = results.filter(result => !result.error);
    const failed = results.filter(result => result.error);
    if (!succeeded.length) {
        throw new Error(failed.map(result => result.error.message).join('\n'));
    }

    const succeededSources = succeeded.map(result => result.source);
    const importedEvents = succeeded.flatMap(result => result.events);
    if (auth?.currentUser && db) {
        const scheduleRef = collection(db, 'artifacts', appId, 'public', 'data', 'schedule');
        const snapshot = await getDocs(scheduleRef);
        const currentEvents = snapshot.docs.map(entry => ({ id: entry.id, ...entry.data() }));
        const obsoleteEvents = currentEvents.filter(event => event.isAutoSync
            && (!event.source || succeededSources.includes(event.source)));
        await Promise.all(obsoleteEvents.map(event => deleteDoc(doc(scheduleRef, event.id))));
        await Promise.all(importedEvents.map(event => {
            const { id, ...eventData } = event;
            return setDoc(doc(scheduleRef, id), eventData);
        }));
        scheduleList = [
            ...currentEvents.filter(event => !obsoleteEvents.some(obsolete => obsolete.id === event.id)),
            ...importedEvents
        ];
    } else {
        scheduleList = [
            ...scheduleList.filter(event => !event.isAutoSync
                || (event.source && !succeededSources.includes(event.source))),
            ...importedEvents
        ];
        saveLocalItems(LOCAL_SCHEDULE_KEY, scheduleList);
    }
    renderSchedule();

    return {
        eventCount: importedEvents.length,
        errors: failed.map(result => result.error.message)
    };
}

// Save Favorite Teams Logic
document.getElementById('btn-save-teams').addEventListener('click', async () => {
    const btn = document.getElementById('btn-save-teams');
    const pl = document.getElementById('input-pl-team').value;
    const laliga = document.getElementById('input-laliga-team').value;

    try {
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...';
        teamsData = { pl, laliga };
        localStorage.setItem(LOCAL_TEAMS_KEY, JSON.stringify(teamsData));
        if (auth?.currentUser && db) {
            const teamsRef = doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'teams');
            await setDoc(teamsRef, teamsData, { merge: true });
        }
        const result = await syncOnlineSchedules(pl, laliga);
        btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> Save & Sync Schedules';
        const message = result.errors.length
            ? `Saved ${result.eventCount} schedule items. Some sources failed:\n${result.errors.join('\n')}`
            : `Favorite teams saved. Synced ${result.eventCount} football fixtures/results and F1 sessions.`;
        await showModal(result.errors.length ? 'Partially synced' : 'Schedules updated', message, 'alert');
    } catch (error) {
        console.error('Could not sync schedules.', error);
        btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> Save & Sync Schedules';
        await showModal('Sync failed', error.message || 'Could not sync schedules.', 'alert');
    }
});

// --- Tasks Logic ---
function renderTasks() {
    const list = document.getElementById('tasks-list');
    list.innerHTML = '';
    tasksList.forEach(task => {
        const li = document.createElement('li');
        li.className = `flex items-center gap-3 p-3 rounded-xl border transition-colors ${task.completed ? 'bg-gray-50 border-gray-100 opacity-60' : 'bg-white border-gray-200'}`;
        li.innerHTML = `
            <button class="text-xl btn-toggle-task ${task.completed ? 'text-blue-500' : 'text-gray-300 hover:text-gray-400'}" data-id="${task.id}" data-val="${task.completed}">
                <i class="${task.completed ? 'fas fa-check-circle' : 'far fa-circle'}"></i>
            </button>
            <span class="flex-1 text-sm font-medium ${task.completed ? 'line-through text-gray-500' : 'text-gray-700'}">${task.text}</span>
            <button class="text-red-400 hover:text-red-600 p-1 btn-del-task" data-id="${task.id}"><i class="fas fa-trash-alt"></i></button>
        `;
        list.appendChild(li);
    });

    document.querySelectorAll('.btn-toggle-task').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            const currentVal = e.currentTarget.getAttribute('data-val') === 'true';
            try {
                if (auth?.currentUser && db) {
                    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tasks', id), { completed: !currentVal });
                } else {
                    tasksList = tasksList.map(task => task.id === id ? { ...task, completed: !currentVal } : task);
                    saveLocalItems(LOCAL_TASKS_KEY, tasksList);
                    renderTasks();
                }
            } catch (error) {
                console.error("Error updating task", error);
                await showModal("Error", "Could not update this task.", "alert");
            }
        });
    });

    document.querySelectorAll('.btn-del-task').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            try {
                if (auth?.currentUser && db) {
                    await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tasks', id));
                } else {
                    tasksList = tasksList.filter(task => task.id !== id);
                    saveLocalItems(LOCAL_TASKS_KEY, tasksList);
                    renderTasks();
                }
            } catch (error) {
                console.error("Error deleting task", error);
                await showModal("Error", "Could not delete this task.", "alert");
            }
        });
    });
}

document.getElementById('btn-add-task').addEventListener('click', async () => {
    const input = document.getElementById('new-task-input');
    const text = input.value.trim();
    if (!text) return;
    try {
        const task = { text, completed: false, timestamp: Date.now() };
        if (auth?.currentUser && db) {
            await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tasks'), task);
        } else {
            tasksList.push({ ...task, id: createLocalId() });
            saveLocalItems(LOCAL_TASKS_KEY, tasksList);
            renderTasks();
        }
        input.value = '';
    } catch (error) {
        console.error("Error adding task", error);
        await showModal("Error", "Could not save this task.", "alert");
    }
});

// --- Init App ---
if (auth) {
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            const token = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
            if (token) {
                await signInWithCustomToken(auth, token);
            } else {
                await signInAnonymously(auth);
            }
        }
    });
}

// Show login view by default
showView(views.login, "", false, false);
