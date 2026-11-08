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

const LOCAL_TASKS_KEY = 'child-status-app.tasks';
const LOCAL_SCHEDULE_KEY = 'child-status-app.schedule';
const LOCAL_LOGS_KEY = 'child-status-app.logs';
const LOCAL_SUBJECTS_KEY = 'child-status-app.subjects';
const LOCAL_TEAMS_KEY = 'child-status-app.teams';
const LOCAL_MIGRATION_KEY = 'child-status-app.online-migration-v1';

// Global State
let currentUserRole = null; // 'child' | 'parent'
let currentMood = null;
let subjectsList = [];
let tasksList = [];
let logsList = [];
let scheduleList = [];
let teamsData = { pl: '', laliga: '' };
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let parentCalendarMonth = new Date(calendarMonth);
let calendarSelectedDate = getLocalDateString(new Date());
let parentCalendarSelectedDate = calendarSelectedDate;
let dataRefreshInterval = null;
let dataRefreshInProgress = false;

async function apiRequest(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers
        }
    });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || `Request failed (${response.status}).`);
    }
    return result;
}

async function saveSharedRecord(collection, record, id = record.id || globalThis.crypto.randomUUID()) {
    const { id: _id, ...data } = record;
    return apiRequest(`/api/data/${collection}/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(data)
    });
}

function readLegacyItems(key) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(value)) return value;
        console.error(`Legacy data for ${key} is not a list and was skipped.`);
    } catch (error) {
        console.error(`Could not read legacy data for ${key}.`, error);
    }
    return [];
}

async function importLegacyDataIfNeeded() {
    if (localStorage.getItem(LOCAL_MIGRATION_KEY) === 'done') return;

    let teams = { pl: '', laliga: '' };
    try {
        teams = { ...teams, ...JSON.parse(localStorage.getItem(LOCAL_TEAMS_KEY) || '{}') };
    } catch (error) {
        console.error('Could not read legacy favorite teams.', error);
    }
    const legacy = {
        subjects: readLegacyItems(LOCAL_SUBJECTS_KEY),
        tasks: readLegacyItems(LOCAL_TASKS_KEY),
        schedule: readLegacyItems(LOCAL_SCHEDULE_KEY),
        logs: readLegacyItems(LOCAL_LOGS_KEY),
        teams
    };
    await apiRequest('/api/data/import', { method: 'POST', body: JSON.stringify(legacy) });
    localStorage.setItem(LOCAL_MIGRATION_KEY, 'done');
}

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
const scheduleStyles = {
    pl: { color: '#6c2eb9', icon: 'futbol' },
    laliga: { color: '#ee1b24', icon: 'futbol' },
    f1: { color: '#e10600', icon: 'car' },
    class: { color: '#2563eb', icon: 'book' },
    routine: { color: '#6366f1', icon: 'calendar-day' },
    other: { color: '#10b981', icon: 'star' }
};
const availableScheduleIcons = new Set(['calendar-day', 'futbol', 'flag-checkered', 'car', 'book', 'star']);
let editingScheduleItemId = null;

function getScheduleStyle(item) {
    const defaults = scheduleStyles[item.type] || scheduleStyles.other;
    return {
        color: /^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color : defaults.color,
        icon: availableScheduleIcons.has(item.icon) ? item.icon : defaults.icon
    };
}

function setScheduleFormDefaults(prefix, type) {
    const style = scheduleStyles[type] || scheduleStyles.other;
    const icon = document.getElementById(`${prefix}event-icon`);
    const color = document.getElementById(`${prefix}event-color`);
    if (icon) icon.value = style.icon;
    if (color) color.value = style.color;
}

function resetScheduleForm(prefix, isRoutine) {
    const formName = isRoutine ? 'routine' : 'event';
    const form = document.getElementById(`${prefix}${formName}-form-container`);
    const button = document.getElementById(`${prefix}btn-add-${formName}`);
    const heading = document.getElementById(`${prefix}${formName}-form-heading`);
    if (form) form.classList.add('hidden');
    if (button) button.textContent = isRoutine ? 'Save Weekly Routine' : 'Save Event';
    if (heading) heading.textContent = isRoutine ? 'New Weekly Routine' : 'New Event';
    editingScheduleItemId = null;
}

async function saveScheduleItem(isRoutine, prefix) {
    const formName = isRoutine ? 'routine' : 'event';
    const title = document.getElementById(`${prefix}${formName}-title`).value.trim();
    const time = document.getElementById(`${prefix}${formName}-time`).value;
    if (!title || !time || (!isRoutine && !document.getElementById(`${prefix}event-date`).value)) {
        await showModal('Missing Info', isRoutine
            ? 'Please provide a time and activity name.'
            : 'Please provide a date, time, and title.', 'alert');
        return;
    }

    const type = isRoutine ? 'routine' : document.getElementById(`${prefix}event-type`).value;
    const existingItem = scheduleList.find(existing => existing.id === editingScheduleItemId);
    const item = {
        ...existingItem,
        isRoutine,
        time,
        type,
        title,
        icon: document.getElementById(`${prefix}${formName}-icon`).value,
        color: document.getElementById(`${prefix}${formName}-color`).value,
        timestamp: Date.now()
    };
    if (isRoutine) {
        item.day = Number(document.getElementById(`${prefix}routine-day`).value);
    } else {
        item.date = document.getElementById(`${prefix}event-date`).value;
    }

    try {
        const id = editingScheduleItemId;
        const savedItem = await saveSharedRecord('schedule', item, id || undefined);
        scheduleList = id
            ? scheduleList.map(existing => existing.id === id ? savedItem : existing)
            : [...scheduleList, savedItem];
        document.getElementById(`${prefix}${formName}-time`).value = '';
        document.getElementById(`${prefix}${formName}-title`).value = '';
        if (!isRoutine) document.getElementById(`${prefix}event-date`).value = '';
        resetScheduleForm(prefix, isRoutine);
        renderSchedule();
    } catch (error) {
        console.error(`Error saving ${isRoutine ? 'routine' : 'event'}`, error);
        await showModal('Error', `Could not save this ${isRoutine ? 'weekly routine' : 'event'}.`, 'alert');
    }
}

function editScheduleItem(item) {
    const prefix = currentUserRole === 'parent' ? 'parent-' : '';
    const isRoutine = item.isRoutine !== false;
    const formName = isRoutine ? 'routine' : 'event';
    const form = document.getElementById(`${prefix}${formName}-form-container`);
    if (!form) return;
    document.getElementById(`${prefix}event-form-container`)?.classList.add('hidden');
    document.getElementById(`${prefix}routine-form-container`)?.classList.add('hidden');
    form.classList.remove('hidden');
    editingScheduleItemId = item.id;

    document.getElementById(`${prefix}${formName}-time`).value = item.time || '';
    document.getElementById(`${prefix}${formName}-title`).value = item.title || '';
    document.getElementById(`${prefix}${formName}-icon`).value = getScheduleStyle(item).icon;
    document.getElementById(`${prefix}${formName}-color`).value = getScheduleStyle(item).color;
    if (isRoutine) {
        document.getElementById(`${prefix}routine-day`).value = String(item.day ?? 1);
    } else {
        document.getElementById(`${prefix}event-date`).value = item.date || '';
        document.getElementById(`${prefix}event-type`).value = scheduleStyles[item.type] ? item.type : 'other';
    }
    const button = document.getElementById(`${prefix}btn-add-${formName}`);
    const heading = document.getElementById(`${prefix}${formName}-form-heading`);
    if (button) button.textContent = isRoutine ? 'Update Routine' : 'Update Event';
    if (heading) heading.textContent = isRoutine ? 'Edit Weekly Routine' : 'Edit Event';
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function setupScheduleForms(prefix) {
    document.getElementById(`${prefix}show-event-form`).addEventListener('click', () => {
        document.getElementById(`${prefix}event-form-container`).classList.toggle('hidden');
        document.getElementById(`${prefix}routine-form-container`).classList.add('hidden');
        editingScheduleItemId = null;
        const button = document.getElementById(`${prefix}btn-add-event`);
        if (button) button.textContent = 'Save Event';
    });
    document.getElementById(`${prefix}show-routine-form`).addEventListener('click', () => {
        document.getElementById(`${prefix}routine-form-container`).classList.toggle('hidden');
        document.getElementById(`${prefix}event-form-container`).classList.add('hidden');
        editingScheduleItemId = null;
        const button = document.getElementById(`${prefix}btn-add-routine`);
        if (button) button.textContent = 'Save Weekly Routine';
    });
    document.getElementById(`${prefix}event-type`).addEventListener('change', event => {
        setScheduleFormDefaults(prefix, event.target.value);
    });
    document.getElementById(`${prefix}btn-add-event`).addEventListener('click', () => saveScheduleItem(false, prefix));
    document.getElementById(`${prefix}btn-add-routine`).addEventListener('click', () => saveScheduleItem(true, prefix));
}

setupScheduleForms('');
setupScheduleForms('parent-');

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
            const style = getScheduleStyle(event);
            eventLabel.style.backgroundColor = style.color;
            eventLabel.style.color = getReadableTextColor(style.color);
            eventLabel.title = `${event.time || ''} ${event.title}`.trim();
            eventLabel.innerHTML = `<i class="fas fa-${style.icon}" aria-hidden="true"></i> `;
            eventLabel.append(document.createTextNode(`${event.time ? `${event.time} ` : ''}${event.title}`));
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

function getReadableTextColor(hexColor) {
    const color = hexColor.slice(1);
    const channels = [0, 2, 4].map(index => parseInt(color.slice(index, index + 2), 16) / 255);
    const luminance = channels.map(channel => channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4)
        .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
    return luminance > 0.38 ? '#111827' : '#ffffff';
}

function getScheduleEventsForDate(dateString) {
    const date = new Date(`${dateString}T00:00:00`);
    return scheduleList
        .filter(event => event.isRoutine !== false
            ? Number(event.day) === date.getDay()
            : event.date === dateString)
        .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

function renderSelectedDaySchedule(headingId, containerId, dateString, canManage) {
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

        const style = getScheduleStyle(event);
        row.style.borderLeft = `4px solid ${style.color}`;
        row.style.backgroundColor = `${style.color}12`;
        const icon = document.createElement('i');
        icon.className = `fas fa-${style.icon} mt-1`;
        icon.style.color = style.color;
        icon.setAttribute('aria-hidden', 'true');
        row.insertBefore(icon, details);

        if (canManage && event.id) {
            const actions = document.createElement('div');
            actions.className = 'flex shrink-0 items-center gap-2';
            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.className = 'btn-edit-schedule text-indigo-600 hover:text-indigo-800 p-1';
            editButton.dataset.id = event.id;
            editButton.setAttribute('aria-label', `Edit ${event.title || 'schedule item'}`);
            editButton.innerHTML = '<i class="fas fa-pen" aria-hidden="true"></i>';
            actions.appendChild(editButton);
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'btn-del-schedule shrink-0 text-red-500 hover:text-red-700 p-1';
            deleteButton.dataset.id = event.id;
            deleteButton.setAttribute('aria-label', `Delete ${event.title || 'schedule item'}`);
            deleteButton.innerHTML = '<i class="fas fa-trash-alt" aria-hidden="true"></i>';
            actions.appendChild(deleteButton);
            row.appendChild(actions);
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

async function handleScheduleActions(event) {
    const editButton = event.target.closest('.btn-edit-schedule');
    const deleteButton = event.target.closest('.btn-del-schedule');
    const button = editButton || deleteButton;
    if (!button) return;
    const item = scheduleList.find(scheduleItem => scheduleItem.id === button.dataset.id);
    if (!item) return;
    if (editButton) {
        editScheduleItem(item);
        return;
    }

    try {
        await apiRequest(`/api/data/schedule/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        scheduleList = scheduleList.filter(scheduleItem => scheduleItem.id !== item.id);
        renderSchedule();
    } catch (error) {
        console.error('Error deleting schedule event', error);
        await showModal('Error', 'Could not delete this schedule item.', 'alert');
    }
}

document.getElementById('calendar-day-schedule').addEventListener('click', handleScheduleActions);
document.getElementById('parent-calendar-day-schedule').addEventListener('click', handleScheduleActions);

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
                        <div class="font-semibold text-indigo-900">${escapeHtml(log.testSubject || 'Subject N/A')}</div>
                    </div>
                    <div class="text-right">
                        <div class="text-lg font-bold text-indigo-700">${escapeHtml(log.testScore || '-')}</div>
                        <div class="text-xs text-indigo-500">${escapeHtml(log.testResult || '-')}</div>
                    </div>
                </div>
            `;
        }

        card.innerHTML = `
            <div class="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                <div>
                    <div class="font-bold text-gray-800">${escapeHtml(log.dateStr)}</div>
                    <div class="text-xs text-gray-500">${timeStr}</div>
                </div>
                <div class="flex items-center gap-2 bg-white px-3 py-1 rounded-full shadow-sm">
                    <span class="text-2xl">${getMoodEmoji(log.mood)}</span>
                    <span class="text-sm font-semibold text-gray-700">${escapeHtml(log.mood)}</span>
                </div>
            </div>
            <div class="p-4 space-y-4">
                <div class="grid grid-cols-4 gap-2 text-center">
                    <div class="bg-blue-50 p-2 rounded-xl">
                        <div class="text-xs text-blue-500 mb-1">Free</div>
                        <div class="font-bold text-blue-700">${escapeHtml(log.freeTime)}/10</div>
                    </div>
                    <div class="bg-red-50 p-2 rounded-xl">
                        <div class="text-xs text-red-500 mb-1">Stress</div>
                        <div class="font-bold text-red-700">${escapeHtml(log.stress)}/10</div>
                    </div>
                    <div class="bg-emerald-50 p-2 rounded-xl">
                        <div class="text-xs text-emerald-500 mb-1">Screen</div>
                        <div class="font-bold text-emerald-700">${escapeHtml(log.screenTime || 0)}h</div>
                    </div>
                    <div class="bg-purple-50 p-2 rounded-xl">
                        <div class="text-xs text-purple-500 mb-1">Sleep</div>
                        <div class="font-bold text-purple-700">${escapeHtml(log.sleepTime || '-')}</div>
                    </div>
                </div>

                ${testSection}

                <div class="space-y-3 pt-2">
                    ${log.interesting ? `
                    <div>
                        <div class="text-xs font-bold text-gray-400 mb-1 uppercase tracking-wider">Most Interesting</div>
                        <p class="text-sm text-gray-700 bg-gray-50 p-3 rounded-xl">${escapeHtml(log.interesting)}</p>
                    </div>` : ''}

                    ${log.happened ? `
                    <div>
                        <div class="text-xs font-bold text-gray-400 mb-1 uppercase tracking-wider">Happened Today</div>
                        <p class="text-sm text-gray-700 bg-gray-50 p-3 rounded-xl">${escapeHtml(log.happened)}</p>
                    </div>` : ''}
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
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
        true
    );
}


// --- Shared database sync ---
async function refreshSharedData() {
    let data = await apiRequest('/api/data');
    if (currentUserRole === 'child' && localStorage.getItem(LOCAL_MIGRATION_KEY) !== 'done') {
        await importLegacyDataIfNeeded();
        data = await apiRequest('/api/data');
    }

    subjectsList = data.subjects || [];
    tasksList = (data.tasks || []).sort((a, b) => {
        if (a.completed === b.completed) return (a.timestamp || 0) - (b.timestamp || 0);
        return a.completed ? 1 : -1;
    });
    scheduleList = data.schedule || [];
    logsList = data.logs || [];
    teamsData = { pl: '', laliga: '', ...(data.settings?.teams || {}) };

    const plInput = document.getElementById('input-pl-team');
    const laligaInput = document.getElementById('input-laliga-team');
    if (plInput) plInput.value = teamsData.pl;
    if (laligaInput) laligaInput.value = teamsData.laliga;
    renderSubjects();
    renderTasks();
    renderSchedule();
    renderParentLogs();
    renderParentSchedule();
}

async function startDataSync() {
    cleanupListeners();
    await refreshSharedData();
    dataRefreshInterval = setInterval(async () => {
        if (dataRefreshInProgress) return;
        dataRefreshInProgress = true;
        try {
            await refreshSharedData();
        } catch (error) {
            console.error('Could not refresh shared data.', error);
        } finally {
            dataRefreshInProgress = false;
        }
    }, 5000);
}

function cleanupListeners() {
    if (dataRefreshInterval) clearInterval(dataRefreshInterval);
    dataRefreshInterval = null;
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
async function login(role) {
    const profileName = role === 'child' ? 'Child' : 'Parent';
    const pin = await showModal(`${profileName} Login`, `Enter ${profileName} PIN:`, 'prompt');
    if (pin === null) return;

    try {
        await apiRequest('/api/login', {
            method: 'POST',
            body: JSON.stringify({ role, pin })
        });
        currentUserRole = role;
        await startDataSync();
        showView(role === 'child' ? views.childDash : views.parentDash,
            `${profileName} Dashboard`, true, false);
    } catch (error) {
        currentUserRole = null;
        cleanupListeners();
        console.error(`Could not log in as ${profileName.toLowerCase()}.`, error);
        const message = error.message === 'Incorrect profile PIN.'
            ? 'Incorrect PIN.'
            : error.message.startsWith('Too many incorrect PIN attempts.')
                ? error.message
                : 'Could not connect to shared storage. Please try again later.';
        await showModal('Login failed', message, 'alert');
    }
}

document.getElementById('login-child').addEventListener('click', () => login('child'));
document.getElementById('login-parent').addEventListener('click', () => login('parent'));

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

btnLogout.addEventListener('click', async () => {
    currentUserRole = null;
    cleanupListeners();
    try {
        await apiRequest('/api/logout', { method: 'POST' });
    } catch (error) {
        console.error('Could not end the server session.', error);
    }
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
        const logId = existingLog?.id || dayKey;
        const savedLog = await saveSharedRecord('logs', logData, logId);
        logsList = existingLog
            ? logsList.map(log => log.id === logId ? savedLog : log)
            : [...logsList, savedLog];
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
                await apiRequest(`/api/data/subjects/${encodeURIComponent(id)}`, { method: 'DELETE' });
                subjectsList = subjectsList.filter(subject => subject.id !== id);
                renderSubjects();
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
        subjectsList.push(await saveSharedRecord('subjects', { name, timestamp: Date.now() }));
        renderSubjects();
        input.value = '';
    } catch (error) {
        console.error('Error adding subject', error);
        await showModal('Error', 'Could not save this subject.', 'alert');
    }
});

async function fetchApiJson(url) {
    return apiRequest(url);
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
            ...scheduleStyles[type],
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
            ...scheduleStyles.f1,
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
    const syncedEvents = succeeded.flatMap(result => result.events);
    const sharedData = await apiRequest('/api/data');
    const currentEvents = sharedData.schedule || [];
    const importedEvents = syncedEvents.map(event => {
        const existing = currentEvents.find(item => item.id === event.id);
        return existing ? { ...event, color: existing.color || event.color, icon: existing.icon || event.icon } : event;
    });
    const obsoleteEvents = currentEvents.filter(event => event.isAutoSync
        && (!event.source || succeededSources.includes(event.source)));
    await Promise.all(obsoleteEvents.map(event =>
        apiRequest(`/api/data/schedule/${encodeURIComponent(event.id)}`, { method: 'DELETE' })));
    await Promise.all(importedEvents.map(event => saveSharedRecord('schedule', event, event.id)));
    scheduleList = [
        ...currentEvents.filter(event => !obsoleteEvents.some(obsolete => obsolete.id === event.id)),
        ...importedEvents
    ];
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
        await saveSharedRecord('settings', teamsData, 'teams');
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
        const color = /^#[0-9a-f]{6}$/i.test(task.color || '') ? task.color : '#3b82f6';
        li.style.borderLeft = `4px solid ${color}`;
        li.innerHTML = `
            <button class="text-xl btn-toggle-task ${task.completed ? 'text-blue-500' : 'text-gray-300 hover:text-gray-400'}" data-id="${task.id}" data-val="${task.completed}">
                <i class="${task.completed ? 'fas fa-check-circle' : 'far fa-circle'}"></i>
            </button>
            <span class="flex-1 text-sm font-medium ${task.completed ? 'line-through text-gray-500' : 'text-gray-700'}">${escapeHtml(task.text)}</span>
            <button class="text-red-400 hover:text-red-600 p-1 btn-del-task" data-id="${task.id}"><i class="fas fa-trash-alt"></i></button>
        `;
        list.appendChild(li);
    });

    document.querySelectorAll('.btn-toggle-task').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            const currentVal = e.currentTarget.getAttribute('data-val') === 'true';
            try {
                const task = tasksList.find(item => item.id === id);
                if (!task) return;
                await saveSharedRecord('tasks', { ...task, completed: !currentVal }, id);
                tasksList = tasksList.map(item => item.id === id ? { ...item, completed: !currentVal } : item);
                renderTasks();
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
                await apiRequest(`/api/data/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
                tasksList = tasksList.filter(task => task.id !== id);
                renderTasks();
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
        const task = {
            text,
            color: document.getElementById('new-task-color').value,
            completed: false,
            timestamp: Date.now()
        };
        tasksList.push(await saveSharedRecord('tasks', task));
        renderTasks();
        input.value = '';
    } catch (error) {
        console.error("Error adding task", error);
        await showModal("Error", "Could not save this task.", "alert");
    }
});

// Show login view by default
showView(views.login, "", false, false);
