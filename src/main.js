
import { Actor } from 'apify';

const BASE = 'https://www.tdlr.texas.gov';
const SEARCH_PAGE = `${BASE}/tabs/search`;
const SEARCH_API = `${BASE}/TABS/Search/SearchProjects`;

const COLUMNS = [
    'ProjectId',
    'ProjectNumber',
    'ProjectName',
    'ProjectCreatedOn',
    'ProjectStatus',
    'FacilityName',
    'City',
    'County',
    'TypeOfWork',
    'EstimatedCost',
    'DataVersionId',
];

const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

function formatDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD.`);
    }

    const [year, month, day] = value.split('-');

    const date = new Date(`${value}T00:00:00Z`);

    if (
        Number.isNaN(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value
    ) {
        throw new Error(`Invalid calendar date: ${value}`);
    }

    return `${month}/${day}/${year}`;
}

function makeBody(input, start, length, draw) {
    const body = new URLSearchParams();

    body.set('draw', String(draw));

    COLUMNS.forEach((name, index) => {
        const prefix = `columns[${index}]`;

        body.set(`${prefix}[data]`, name);
        body.set(`${prefix}[name]`, '');
        body.set(`${prefix}[searchable]`, index === 10 ? 'false' : 'true');
        body.set(`${prefix}[orderable]`, 'true');
        body.set(`${prefix}[search][value]`, '');
        body.set(`${prefix}[search][regex]`, 'false');
    });

    body.set('order[0][column]', '3');
    body.set('order[0][dir]', 'desc');

    body.set('start', String(start));
    body.set('length', String(length));

    body.set('search[value]', '');
    body.set('search[regex]', 'false');

    body.set(
        'RegistrationDateBegin',
        formatDate(input.startDate)
    );

    body.set(
        'RegistrationDateEnd',
        formatDate(input.endDate)
    );

    if (input.city) {
        body.set('City', input.city);
    }

    if (input.county) {
        body.set('County', input.county);
    }

    if (input.status) {
        body.set('ProjectStatus', input.status);
    }

    return body;
}

async function requestWithRetry(url, options = {}) {
    let lastError;

    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                signal: AbortSignal.timeout(45000),
            });

            if (!response.ok) {
                throw new Error(
                    `HTTP ${response.status}: ${url}`
                );
            }

            return response;
        } catch (error) {
            lastError = error;

            console.warn(
                `Request attempt ${attempt} failed: ${error.message}`
            );

            if (attempt < 4) {
                await sleep(1500 * attempt);
            }
        }
    }

    throw lastError;
}

await Actor.init();

try {
    const input = await Actor.getInput();

    if (!input?.startDate || !input?.endDate) {
        throw new Error('Start and end dates are required.');
    }

    formatDate(input.startDate);
    formatDate(input.endDate);

    if (input.startDate > input.endDate) {
        throw new Error('Start date must precede end date.');
    }

    const pageSize = 50;
    const maxResults = input.maxResults ?? 10000;

    if (
        !Number.isInteger(maxResults) ||
        maxResults < 1
    ) {
        throw new Error('maxResults must be a positive integer.');
    }

    console.log(
        `TDLR extraction: ${input.startDate} through ${input.endDate}`
    );

    // Establish a normal public-site session.
    const session = await requestWithRetry(SEARCH_PAGE);

    // Some sites require a session cookie for subsequent requests.
    // This is a public search; no login credentials are used.
    const setCookie = session.headers.get('set-cookie');

    const cookie = setCookie
        ? setCookie
            .split(/,(?=\s*[^;,=\s]+=[^;,]+)/)
            .map((item) => item.split(';')[0].trim())
            .join('; ')
        : '';

    const headers = {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type':
            'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': SEARCH_PAGE,
    };

    if (cookie) {
        headers.Cookie = cookie;
    }

    const projects = new Map();

    let start = 0;
    let draw = 1;
    let expectedTotal = null;

    while (true) {
        const body = makeBody(
            input,
            start,
            pageSize,
            draw
        );

        const response = await requestWithRetry(
            SEARCH_API,
            {
                method: 'POST',
                headers,
                body: body.toString(),
            }
        );

        const result = await response.json();

        if (
            !Array.isArray(result.data) ||
            !Number.isInteger(result.recordsFiltered)
        ) {
            throw new Error(
                'Unexpected TDLR response format.'
            );
        }

        if (expectedTotal === null) {
            expectedTotal = result.recordsFiltered;

            console.log(
                `TDLR reports ${expectedTotal} matching registrations.`
            );

            if (expectedTotal > maxResults) {
                throw new Error(
                    `Found ${expectedTotal} registrations, ` +
                    `but maxResults is ${maxResults}. ` +
                    'Increase the limit to avoid incomplete extraction.'
                );
            }
        }

        if (result.recordsFiltered !== expectedTotal) {
            throw new Error(
                'TDLR result count changed during extraction. ' +
                'Rerun to obtain a consistent dataset.'
            );
        }

        if (
            result.data.length === 0 &&
            start < expectedTotal
        ) {
            throw new Error(
                `Empty page before completion at offset ${start}.`
            );
        }

        for (const project of result.data) {
            const id = project.ProjectNumber;

            if (!id) {
                throw new Error(
                    'Project record is missing its project number.'
                );
            }

            if (projects.has(id)) {
                throw new Error(
                    `Duplicate project number encountered: ${id}`
                );
            }

            const date = String(
                project.ProjectCreatedOn ?? ''
            ).slice(0, 10);

            if (
                date < input.startDate ||
                date > input.endDate
            ) {
                throw new Error(
                    `Project ${id} is outside the requested date range.`
                );
            }

            projects.set(id, {
                ...project,
                RegistrationDate: date,
                Source: SEARCH_API,
            });
        }

        start += result.data.length;

        console.log(
            `Collected ${projects.size} of ${expectedTotal} records.`
        );

        if (start >= expectedTotal) {
            break;
        }

        draw++;

        // Keep request frequency modest.
        await sleep(750);
    }

    if (projects.size !== expectedTotal) {
        throw new Error(
            `Incomplete extraction: ${projects.size} ` +
            `of ${expectedTotal} records.`
        );
    }

    // Save only after the complete dataset is validated.
    const records = [...projects.values()];

    for (let i = 0; i < records.length; i += 100) {
        await Actor.pushData(records.slice(i, i + 100));
    }

    await Actor.setValue('EXTRACTION_SUMMARY', {
        startDate: input.startDate,
        endDate: input.endDate,
        expectedTotal,
        extractedTotal: records.length,
        complete: true,
        extractedAt: new Date().toISOString(),
    });

    console.log(
        `SUCCESS: Saved all ${records.length} registrations.`
    );

} catch (error) {
    console.error('EXTRACTION FAILED:', error);

    await Actor.setValue('EXTRACTION_ERROR', {
        message: error.message,
        timestamp: new Date().toISOString(),
    });

    throw error;

} finally {
    await Actor.exit();
}
