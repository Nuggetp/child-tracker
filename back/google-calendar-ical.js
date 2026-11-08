const crypto = require('node:crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function validateCalendarUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw Object.assign(new Error('Enter a valid Google Calendar iCal link.'), { status: 400 });
    }

    if (url.protocol !== 'https:'
        || url.hostname !== 'calendar.google.com'
        || url.port
        || url.username
        || url.password
        || url.search
        || url.hash
        || !/^\/calendar\/ical\/[^/]+\/private-[A-Za-z0-9_-]+\/basic\.ics$/.test(url.pathname)) {
        throw Object.assign(new Error('Use the private iCal link from Google Calendar settings.'), { status: 400 });
    }
    return url.toString();
}

function isAllowedCalendarRedirect(url) {
    return url.protocol === 'https:'
        && !url.port
        && !url.username
        && !url.password
        && (url.hostname === 'calendar.google.com'
            || url.hostname === 'calendar.googleusercontent.com'
            || url.hostname.endsWith('.googleusercontent.com'));
}

async function readCalendarResponse(response, maxBytes) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = '';
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel();
            throw Object.assign(new Error('The Google Calendar iCal feed is too large to import.'), { status: 502 });
        }
        result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
}

async function fetchCalendarFeed(value, { signal, fetchImpl = fetch } = {}) {
    let url = validateCalendarUrl(value);
    for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
        const response = await fetchImpl(url, {
            signal,
            redirect: 'manual',
            headers: { Accept: 'text/calendar, text/plain;q=0.9' }
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location || redirectCount === 5) {
                throw Object.assign(new Error('Google Calendar returned too many redirects. Check the private iCal link.'), { status: 502 });
            }
            const redirectUrl = new URL(location, url);
            if (!isAllowedCalendarRedirect(redirectUrl)) {
                throw Object.assign(new Error('Google Calendar redirected to an unsupported address.'), { status: 502 });
            }
            url = redirectUrl.toString();
            continue;
        }
        if (!response.ok) {
            throw Object.assign(new Error(`Google Calendar returned HTTP ${response.status}. Check that the private iCal link is current.`), { status: 502 });
        }
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > 5 * 1024 * 1024) {
            throw Object.assign(new Error('The Google Calendar iCal feed is too large to import.'), { status: 502 });
        }
        const calendarText = await readCalendarResponse(response, 5 * 1024 * 1024);
        if (!calendarText.includes('BEGIN:VCALENDAR')) {
            throw Object.assign(new Error('Google did not return a valid iCalendar feed. Check the private iCal link.'), { status: 502 });
        }
        return calendarText;
    }
    throw Object.assign(new Error('Could not follow the Google Calendar iCal link.'), { status: 502 });
}

function unfoldCalendarLines(calendarText) {
    return calendarText.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

function parseProperty(line) {
    const separator = line.indexOf(':');
    if (separator < 0) return null;
    const descriptor = line.slice(0, separator).split(';');
    const parameters = Object.fromEntries(descriptor.slice(1).map(parameter => {
        const index = parameter.indexOf('=');
        return index < 0 ? [parameter.toUpperCase(), ''] : [
            parameter.slice(0, index).toUpperCase(),
            parameter.slice(index + 1).replace(/^"|"$/g, '')
        ];
    }));
    return {
        name: descriptor[0].toUpperCase(),
        parameters,
        value: line.slice(separator + 1)
    };
}

function parseDateValue(property) {
    if (!property) return null;
    const match = property.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
    if (!match) return null;
    const [, year, month, day, hour = '00', minute = '00', second = '00', utc] = match;
    const date = `${year}-${month}-${day}`;
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
    const parsedDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (parsedDate.toISOString().slice(0, 10) !== date) return null;
    return {
        date,
        time: property.parameters.VALUE === 'DATE' || !match[4] ? '' : `${hour}:${minute}`,
        timestamp: utc
            ? Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
            : Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
        dateNumber: Date.UTC(Number(year), Number(month) - 1, Number(day)) / DAY_MS,
        isDate: !match[4]
    };
}

function unescapeText(value) {
    return value.replace(/\\[nN]/g, '\n').replace(/\\([,;\\])/g, '$1');
}

function parseCalendarEvents(calendarText) {
    if (typeof calendarText !== 'string' || calendarText.length > 5 * 1024 * 1024
        || !calendarText.includes('BEGIN:VCALENDAR')) {
        throw Object.assign(new Error('The link did not return a valid iCalendar file.'), { status: 502 });
    }

    const events = [];
    let current = null;
    for (const line of unfoldCalendarLines(calendarText)) {
        if (line === 'BEGIN:VEVENT') {
            current = {};
            continue;
        }
        if (line === 'END:VEVENT') {
            if (current) events.push(current);
            current = null;
            continue;
        }
        if (!current) continue;
        const property = parseProperty(line);
        if (!property) continue;
        if (property.name === 'EXDATE') {
            const excluded = property.value.split(',').map(value =>
                parseDateValue({ ...property, value })?.date).filter(Boolean);
            current.excludedDates = [...(current.excludedDates || []), ...excluded];
        } else {
            current[property.name] = property;
        }
    }
    return events;
}

function parseRecurrenceRule(ruleProperty) {
    if (!ruleProperty) return null;
    return Object.fromEntries(ruleProperty.value.split(';').map(part => {
        const separator = part.indexOf('=');
        return separator < 0
            ? [part.toUpperCase(), '']
            : [part.slice(0, separator).toUpperCase(), part.slice(separator + 1).toUpperCase()];
    }));
}

function getOccurrenceDates(event, startDateNumber, endDateNumber) {
    const start = parseDateValue(event.DTSTART);
    if (!start) return [];
    const rule = parseRecurrenceRule(event.RRULE);
    const excludedDates = new Set(event.excludedDates || []);
    const until = rule?.UNTIL ? parseDateValue({ value: rule.UNTIL, parameters: {} })?.dateNumber : null;
    const interval = Math.max(1, Number(rule?.INTERVAL) || 1);
    const countLimit = rule?.COUNT ? Math.max(0, Number(rule.COUNT)) : Infinity;
    const weekdays = rule?.BYDAY
        ? rule.BYDAY.split(',').map(day => DAY_CODES[day.slice(-2)]).filter(Number.isInteger)
        : [new Date(start.dateNumber * DAY_MS).getUTCDay()];

    if (rule && !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.FREQ)) return [];
    const output = [];
    const first = Math.max(start.dateNumber, startDateNumber);
    const last = Math.min(endDateNumber - 1, until ?? Infinity);
    let occurrenceCount = 0;
    for (let dateNumber = start.dateNumber; dateNumber <= last; dateNumber++) {
        const date = new Date(dateNumber * DAY_MS);
        const dayOffset = dateNumber - start.dateNumber;
        const weekStart = Math.floor((start.dateNumber + 3) / 7);
        const currentWeek = Math.floor((dateNumber + 3) / 7);
        const monthOffset = (date.getUTCFullYear() - Number(start.date.slice(0, 4))) * 12
            + date.getUTCMonth() - (Number(start.date.slice(5, 7)) - 1);
        let matches = !rule;

        if (rule?.FREQ === 'DAILY') matches = dayOffset % interval === 0;
        if (rule?.FREQ === 'WEEKLY') {
            matches = (currentWeek - weekStart) % interval === 0 && weekdays.includes(date.getUTCDay());
        }
        if (rule?.FREQ === 'MONTHLY') {
            matches = monthOffset >= 0 && monthOffset % interval === 0
                && date.getUTCDate() === Number(start.date.slice(8, 10));
        }
        if (rule?.FREQ === 'YEARLY') {
            matches = (date.getUTCFullYear() - Number(start.date.slice(0, 4))) % interval === 0
                && date.getUTCMonth() === Number(start.date.slice(5, 7)) - 1
                && date.getUTCDate() === Number(start.date.slice(8, 10));
        }
        if (!matches) continue;
        occurrenceCount++;
        if (occurrenceCount > countLimit) break;
        if (dateNumber >= first && !excludedDates.has(date.toISOString().slice(0, 10))) {
            output.push(date.toISOString().slice(0, 10));
        }
        if (output.length >= 1000) break;
    }
    return output;
}

function mapCalendarEvent(event, date) {
    if (event.STATUS?.value === 'CANCELLED' || !event.UID?.value || !event.SUMMARY) return null;
    const title = unescapeText(event.SUMMARY.value).trim();
    if (!title) return null;
    const start = parseDateValue(event.DTSTART);
    const occurrenceDate = parseDateValue({ value: date.replaceAll('-', ''), parameters: { VALUE: 'DATE' } });
    const identity = `${event.UID.value}\n${date}`;
    const id = `google-ical-${crypto.createHash('sha256').update(identity).digest('hex')}`;
    return {
        id,
        isRoutine: false,
        isAutoSync: true,
        isReadOnly: true,
        source: 'google-calendar-ical',
        externalId: event.UID.value.slice(0, 500),
        date,
        time: start?.time || '',
        type: 'google',
        title: title.slice(0, 500),
        color: '#4285f4',
        icon: 'calendar-day',
        timestamp: occurrenceDate.timestamp + (start ? start.timestamp % DAY_MS : 0)
    };
}

function importCalendarEvents(calendarText, startDate, endDate) {
    const startNumber = Date.parse(`${startDate}T00:00:00Z`) / DAY_MS;
    const endNumber = Date.parse(`${endDate}T00:00:00Z`) / DAY_MS;
    return parseCalendarEvents(calendarText).flatMap(event => {
        const start = parseDateValue(event.DTSTART);
        if (!start) return [];
        return getOccurrenceDates(event, startNumber, endNumber)
            .map(date => mapCalendarEvent(event, date))
            .filter(Boolean);
    });
}

module.exports = { fetchCalendarFeed, importCalendarEvents, validateCalendarUrl };
