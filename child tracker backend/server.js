const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = __dirname;
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4173);
const allowedLeagues = new Set(['eng.1', 'esp.1']);
const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
};

function sendJson(response, status, data) {
    response.writeHead(status, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(data));
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
    const requestUrl = new URL(request.url, `http://${host}:${port}`);
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
});

server.listen(port, host, () => {
    console.log(`Child Status App running at http://${host}:${port}/`);
});

server.on('error', error => {
    console.error('Could not start the app server.', error);
    process.exitCode = 1;
});
