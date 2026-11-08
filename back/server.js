const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const root = path.resolve(__dirname, '..', 'public');
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4173);
const allowedLeagues = new Set(['eng.1', 'esp.1']);
const allowedCollections = new Set(['subjects', 'tasks', 'schedule', 'logs', 'settings']);
const sessionCookieName = 'child_status_session';
const sessionDurationSeconds = 60 * 60 * 8;
const maxRequestBodyBytes = 1024 * 1024;
const databaseUrl = process.env.DATABASE_URL;
const sessionSecret = process.env.SESSION_SECRET;
const parentPin = process.env.PARENT_PIN;
const childPin = process.env.CHILD_PIN;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const failedLoginAttempts = new Map();
const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png'
};

function sendJson(response, status, data) {
    response.writeHead(status, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(data));
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        let tooLarge = false;
        request.setEncoding('utf8');
        request.on('data', chunk => {
            if (tooLarge) return;
            body += chunk;
            if (Buffer.byteLength(body) > maxRequestBodyBytes) {
                tooLarge = true;
                reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
            }
        });
        request.on('end', () => {
            if (tooLarge) return;
            try {
                resolve(JSON.parse(body || '{}'));
            } catch {
                reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
            }
        });
        request.on('error', reject);
    });
}

function createSessionToken(role) {
    const payload = Buffer.from(JSON.stringify({
        role,
        expiresAt: Math.floor(Date.now() / 1000) + sessionDurationSeconds
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function getSessionRole(request) {
    const cookies = Object.fromEntries((request.headers.cookie || '').split(';')
        .map(cookie => cookie.trim().split(/=(.*)/s).slice(0, 2))
        .filter(([name, value]) => name && value));
    const token = cookies[sessionCookieName];
    if (!token) return null;

    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest();
    let provided;
    try {
        provided = Buffer.from(signature, 'base64url');
    } catch {
        return null;
    }
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;

    try {
        const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
        return session.expiresAt > Math.floor(Date.now() / 1000) ? session.role : null;
    } catch {
        return null;
    }
}

function setSessionCookie(request, response, token, maxAge) {
    const forwardedProtocol = request.headers['x-forwarded-proto']?.split(',')[0].trim();
    const secure = process.env.NODE_ENV === 'production' || forwardedProtocol === 'https' ? '; Secure' : '';
    response.setHeader('Set-Cookie',
        `${sessionCookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function getLoginAttemptState(address) {
    const now = Date.now();
    const state = failedLoginAttempts.get(address);
    if (!state || state.windowEndsAt <= now) {
        failedLoginAttempts.delete(address);
        return null;
    }
    return state;
}

function recordFailedLogin(address) {
    const now = Date.now();
    const state = getLoginAttemptState(address) || { failures: 0, windowEndsAt: now + 15 * 60 * 1000 };
    state.failures += 1;
    failedLoginAttempts.set(address, state);
    return state.failures >= 5;
}

function isValidRecord(record) {
    return record && typeof record === 'object' && !Array.isArray(record);
}

function isValidRecordId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(id);
}

async function handleDataRequest(request, response, requestUrl, role) {
    if (request.method === 'GET' && requestUrl.pathname === '/api/data') {
        const result = await pool.query('SELECT collection, id, data FROM app_data ORDER BY id');
        const data = Object.fromEntries([...allowedCollections].map(name => [name, name === 'settings' ? {} : []]));
        for (const row of result.rows) {
            if (row.collection === 'settings') {
                data.settings[row.id] = row.data;
            } else {
                data[row.collection].push({ id: row.id, ...row.data });
            }
        }
        sendJson(response, 200, data);
        return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/data/import') {
        if (role !== 'child') {
            sendJson(response, 403, { error: 'Only the child profile can import browser data.' });
            return;
        }
        const records = await readJsonBody(request);
        if (!isValidRecord(records)) {
            sendJson(response, 400, { error: 'A JSON object is required.' });
            return;
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const name of ['subjects', 'tasks', 'schedule', 'logs']) {
                if (records[name] !== undefined && !Array.isArray(records[name])) {
                    throw Object.assign(new Error(`${name} must be a list.`), { status: 400 });
                }
                for (const record of records[name] || []) {
                    if (!isValidRecord(record) || !isValidRecordId(record.id)) {
                        throw Object.assign(new Error(`Invalid record in ${name}.`), { status: 400 });
                    }
                    const { id: recordId, ...recordData } = record;
                    await client.query(
                        'INSERT INTO app_data (collection, id, data) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                        [name, recordId, recordData]
                    );
                }
            }
            if (records.teams !== undefined && !isValidRecord(records.teams)) {
                throw Object.assign(new Error('teams must be an object.'), { status: 400 });
            }
            if (records.teams) {
                await client.query(
                    'INSERT INTO app_data (collection, id, data) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                    ['settings', 'teams', records.teams]
                );
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
        sendJson(response, 200, { success: true });
        return;
    }

    const match = requestUrl.pathname.match(/^\/api\/data\/([a-z]+)(?:\/([^/]+))?$/);
    if (!match || !allowedCollections.has(match[1])) {
        sendJson(response, 404, { error: 'Data endpoint not found.' });
        return;
    }

    const [, collectionName, rawId] = match;
    if (role !== 'child' && !(role === 'parent' && collectionName === 'schedule')) {
        sendJson(response, 403, { error: 'Only the child profile can change this data.' });
        return;
    }

    let id;
    try {
        id = rawId ? decodeURIComponent(rawId) : null;
    } catch {
        sendJson(response, 400, { error: 'Invalid record ID.' });
        return;
    }

    if (request.method === 'PUT' && id && isValidRecordId(id)) {
        const record = await readJsonBody(request);
        if (!isValidRecord(record)) {
            sendJson(response, 400, { error: 'A JSON object is required.' });
            return;
        }
        delete record.id;
        await pool.query(
            `INSERT INTO app_data (collection, id, data)
             VALUES ($1, $2, $3)
             ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data`,
            [collectionName, id, record]
        );
        sendJson(response, 200, { id, ...record });
        return;
    }

    if (request.method === 'DELETE' && id && isValidRecordId(id)) {
        await pool.query('DELETE FROM app_data WHERE collection = $1 AND id = $2', [collectionName, id]);
        sendJson(response, 200, { success: true });
        return;
    }

    sendJson(response, 405, { error: 'Unsupported data operation.' });
}

async function handleParentLogComment(request, response, requestUrl, role) {
    if (role !== 'parent') {
        sendJson(response, 403, { error: 'Only the parent profile can update log comments.' });
        return;
    }
    if (request.method !== 'PUT') {
        sendJson(response, 405, { error: 'Only PUT requests are supported for log comments.' });
        return;
    }

    const match = requestUrl.pathname.match(/^\/api\/logs\/([^/]+)\/comment$/);
    let id;
    try {
        id = match ? decodeURIComponent(match[1]) : null;
    } catch {
        sendJson(response, 400, { error: 'Invalid log ID.' });
        return;
    }
    if (!isValidRecordId(id)) {
        sendJson(response, 400, { error: 'Invalid log ID.' });
        return;
    }

    const body = await readJsonBody(request);
    if (!isValidRecord(body) || typeof body.comment !== 'string' || body.comment.length > 2000) {
        sendJson(response, 400, { error: 'A comment of up to 2000 characters is required.' });
        return;
    }

    const result = await pool.query(
        `UPDATE app_data
         SET data = jsonb_set(data, '{parentComment}', to_jsonb($2::text), true)
         WHERE collection = 'logs' AND id = $1
         RETURNING id, data`,
        [id, body.comment.trim()]
    );
    if (!result.rowCount) {
        sendJson(response, 404, { error: 'Log not found.' });
        return;
    }
    sendJson(response, 200, { id, ...result.rows[0].data });
}

async function proxyJson(response, url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const upstream = await fetch(url, { signal: controller.signal });
        if (!upstream.ok) {
            sendJson(response, 502, { error: `Upstream API returned ${upstream.status}.` });
            return;
        }
        sendJson(response, 200, await upstream.json());
    } catch (error) {
        const message = error.name === 'AbortError' ? 'Upstream API timed out.' : 'Could not reach the upstream API.';
        sendJson(response, 502, { error: message });
    } finally {
        clearTimeout(timeout);
    }
}

async function serveFile(request, response, pathname) {
    let relativePath;
    try {
        relativePath = decodeURIComponent(pathname === '/' ? '/main.html' : pathname);
    } catch {
        sendJson(response, 400, { error: 'Invalid path.' });
        return;
    }

    const filePath = path.resolve(root, `.${relativePath}`);
    if (!filePath.startsWith(`${root}${path.sep}`)) {
        sendJson(response, 403, { error: 'Path is outside the app directory.' });
        return;
    }

    try {
        const file = await fs.readFile(filePath);
        response.writeHead(200, {
            'Cache-Control': 'no-store',
            'Content-Length': file.length,
            'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(request.method === 'HEAD' ? undefined : file);
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR') {
            sendJson(response, 404, { error: 'File not found.' });
            return;
        }
        console.error('Unable to serve file.', error);
        sendJson(response, 500, { error: 'Unable to serve file.' });
    }
}

const server = http.createServer(async (request, response) => {
    try {
        const requestUrl = new URL(request.url, `http://${host}:${port}`);
        if (requestUrl.pathname === '/api/login' && request.method === 'POST') {
            const clientAddress = request.headers['x-forwarded-for']?.split(',')[0].trim()
                || request.socket.remoteAddress
                || 'unknown';
            const attemptState = getLoginAttemptState(clientAddress);
            if (attemptState?.failures >= 5) {
                sendJson(response, 429, { error: 'Too many incorrect PIN attempts. Please wait 15 minutes.' });
                return;
            }
            const credentials = await readJsonBody(request);
            if (!isValidRecord(credentials)) {
                sendJson(response, 400, { error: 'A JSON object is required.' });
                return;
            }
            const { role, pin } = credentials;
            const expectedPin = role === 'parent' ? parentPin : role === 'child' ? childPin : null;
            if (!expectedPin || typeof pin !== 'string' || pin !== expectedPin) {
                if (recordFailedLogin(clientAddress)) {
                    sendJson(response, 429, { error: 'Too many incorrect PIN attempts. Please wait 15 minutes.' });
                    return;
                }
                sendJson(response, 401, { error: 'Incorrect profile PIN.' });
                return;
            }
            failedLoginAttempts.delete(clientAddress);
            setSessionCookie(request, response, createSessionToken(role), sessionDurationSeconds);
            sendJson(response, 200, { role });
            return;
        }

        if (requestUrl.pathname === '/api/logout' && request.method === 'POST') {
            setSessionCookie(request, response, '', 0);
            sendJson(response, 200, { success: true });
            return;
        }

        if (requestUrl.pathname.startsWith('/api/logs/')) {
            const role = getSessionRole(request);
            if (!role) {
                sendJson(response, 401, { error: 'Please log in to update log comments.' });
                return;
            }
            await handleParentLogComment(request, response, requestUrl, role);
            return;
        }

        if (requestUrl.pathname.startsWith('/api/data')) {
            const role = getSessionRole(request);
            if (!role) {
                sendJson(response, 401, { error: 'Please log in to access shared data.' });
                return;
            }
            if (request.method !== 'GET' && request.method !== 'PUT' && request.method !== 'POST' && request.method !== 'DELETE') {
                sendJson(response, 405, { error: 'Unsupported data operation.' });
                return;
            }
            await handleDataRequest(request, response, requestUrl, role);
            return;
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            sendJson(response, 405, { error: 'Only GET and HEAD requests are supported.' });
            return;
        }

        if (requestUrl.pathname === '/api/football/teams') {
            const league = requestUrl.searchParams.get('league');
            if (!allowedLeagues.has(league)) {
                sendJson(response, 400, { error: 'League must be eng.1 or esp.1.' });
                return;
            }
            await proxyJson(response, `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/teams?limit=100`);
            return;
        }

        if (requestUrl.pathname === '/api/football/team-schedule') {
            const league = requestUrl.searchParams.get('league');
            const teamId = requestUrl.searchParams.get('teamId');
            if (!allowedLeagues.has(league) || !/^\d{1,8}$/.test(teamId || '')) {
                sendJson(response, 400, { error: 'A supported league and numeric team ID are required.' });
                return;
            }
            await proxyJson(response, `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/teams/${teamId}/schedule`);
            return;
        }

        if (requestUrl.pathname === '/api/football/scoreboard') {
            const league = requestUrl.searchParams.get('league');
            const date = requestUrl.searchParams.get('date');
            if (!allowedLeagues.has(league) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
                sendJson(response, 400, { error: 'A supported league and ISO date are required.' });
                return;
            }
            const dateValue = new Date(`${date}T00:00:00Z`);
            if (Number.isNaN(dateValue.getTime()) || dateValue.toISOString().slice(0, 10) !== date) {
                sendJson(response, 400, { error: 'Date must be a valid ISO calendar date.' });
                return;
            }
            await proxyJson(response, `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${date.replaceAll('-', '')}`);
            return;
        }

        if (requestUrl.pathname === '/api/f1/schedule') {
            const year = requestUrl.searchParams.get('year');
            const currentYear = new Date().getFullYear();
            if (!/^\d{4}$/.test(year || '') || Number(year) < currentYear - 1 || Number(year) > currentYear + 1) {
                sendJson(response, 400, { error: 'Year must be within one year of the current season.' });
                return;
            }
            await proxyJson(response, `https://api.jolpi.ca/ergast/f1/${year}.json?limit=100`);
            return;
        }

        await serveFile(request, response, requestUrl.pathname);
    } catch (error) {
        if (response.headersSent || response.destroyed) return;
        console.error('Request failed.', error);
        sendJson(response, error.status || 500, {
            error: error.status ? error.message : 'The request could not be completed.'
        });
    }
});

async function startServer() {
    if (!databaseUrl || !sessionSecret || !parentPin || !childPin) {
        throw new Error('DATABASE_URL, SESSION_SECRET, PARENT_PIN, and CHILD_PIN must be configured.');
    }
    if (sessionSecret.length < 32) {
        throw new Error('SESSION_SECRET must contain at least 32 characters.');
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS app_data (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data JSONB NOT NULL,
        PRIMARY KEY (collection, id)
    )`);
    server.listen(port, host, () => {
        console.log(`Child Status App running at http://${host}:${port}/`);
    });
}

startServer().catch(error => {
    console.error('Could not start the app server.', error);
    process.exitCode = 1;
});

server.on('error', error => {
    console.error('Could not start the app server.', error);
    process.exitCode = 1;
});
