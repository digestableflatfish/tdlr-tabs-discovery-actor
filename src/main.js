
import { Actor } from 'apify';

const SEARCH_PAGE = 'https://www.tdlr.texas.gov/tabs/search';
const API = 'https://www.tdlr.texas.gov/TABS/Search/SearchProjects';

const COLUMNS = [
    'ProjectId', 'ProjectNumber', 'ProjectName',
    'ProjectCreatedOn', 'ProjectStatus', 'FacilityName',
    'City', 'County', 'TypeOfWork', 'EstimatedCost',
    'DataVersionId',
];

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const iso = (d) => d.toISOString().slice(0, 10);

function date(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`Expected YYYY-MM-DD: ${value}`);
    }
    const d = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || iso(d) !== value) {
        throw new Error(`Invalid date: ${value}`);
    }
    return d;
}

function us(value) {
    const [y, m, d] = value.split('-');
    return `${m}/${d}/${y}`;
}

function nextMonth(value) {
    const d = date(value);
    return iso(new Date(Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth() + 1,
        1
    )));
}

function previousDay(value) {
    return iso(new Date(date(value).getTime() - 86400000));
}

function ranges(first, last) {
    const out = [];
    let cursor = first;

    while (cursor <= last) {
        const end = previousDay(nextMonth(cursor));
        out.push([cursor, end < last ? end : last]);
        cursor = nextMonth(cursor);
    }
    return out;
}

function body(startDate, endDate, offset, length, draw) {
    const b = new URLSearchParams();
    b.set('draw', String(draw));

    COLUMNS.forEach((name, i) => {
        const p = `columns[${i}]`;
        b.set(`${p}[data]`, name);
        b.set(`${p}[name]`, '');
        b.set(`${p}[searchable]`, i === 10 ? 'false' : 'true');
        b.set(`${p}[orderable]`, 'true');
        b.set(`${p}[search][value]`, '');
        b.set(`${p}[search][regex]`, 'false');
    });

    b.set('order[0][column]', '3');
    b.set('order[0][dir]', 'desc');
    b.set('start', String(offset));
    b.set('length', String(length));
    b.set('search[value]', '');
    b.set('search[regex]', 'false');
    b.set('RegistrationDateBegin', us(startDate));
    b.set('RegistrationDateEnd', us(endDate));

    return b.toString();
}

async function request(url, options = {}) {
    let last;

    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                signal: AbortSignal.timeout(45000),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status} at ${url}`);
            }
            return response;
        } catch (err) {
            last = err;
            if (attempt < 4) await pause(1500 * attempt);
        }
    }
    throw last;
}

function getCookie(response) {
    const values = response.headers.getSetCookie?.() ?? [];
    return values
        .map(v => v.split(';')[0])
        .filter(Boolean)
        .join('; ');
}

async function collect(startDate, endDate, headers, maxPerMonth) {
    const records = new Map();
    let offset = 0;
    let draw = 1;
    let expected = null;

    while (true) {
        const response = await request(API, {
            method: 'POST',
            headers,
            body: body(startDate, endDate, offset, 50, draw),
        });

        const result = await response.json();

        if (
            !Array.isArray(result.data) ||
            !Number.isInteger(result.recordsFiltered)
        ) {
            throw new Error(
                `Unexpected response for ${startDate} to ${endDate}`
            );
        }

        if (expected === null) {
            expected = result.recordsFiltered;

            if (expected > maxPerMonth) {
                throw new Error(
                    `${startDate} to ${endDate}: ${expected} ` +
                    `exceeds maxPerMonth=${maxPerMonth}; ` +
                    'raise the limit or split this range'
                );
            }
        }

        if (result.recordsFiltered !== expected) {
            throw new Error(
                `Count changed during ${startDate} to ${endDate}; retry later`
            );
        }

        if (!result.data.length && offset < expected) {
            throw new Error(
                `Premature empty page at ${offset} for ${startDate}`
            );
        }

        for (const p of result.data) {
            const id = p.ProjectNumber;
            const registered = String(
                p.ProjectCreatedOn ?? ''
            ).slice(0, 10);

            if (
                !id ||
                registered < startDate ||
                registered > endDate ||
                records.has(id)
            ) {
                throw new Error(
                    `Invalid, out-of-range or duplicate record ${id} ` +
                    `in ${startDate} to ${endDate}`
                );
            }

            records.set(id, {
                ...p,
                RegistrationDate: registered,
                Source: API,
            });
        }

        offset += result.data.length;

        if (offset >= expected) break;

        draw++;
        await pause(750);
    }

    if (records.size !== expected) {
        throw new Error(
            `Incomplete ${startDate}: ${records.size}/${expected}`
        );
    }

    return [...records.values()];
}

await Actor.init();

try {
    const input = await Actor.getInput() ?? {};

    const startDate = input.startDate ?? '2021-09-01';
    const endDate = input.endDate ?? '2026-09-18';

    date(startDate);
    date(endDate);

    if (startDate > endDate) {
        throw new Error('startDate must be on or before endDate');
    }

    const maxPerMonth = input.maxPerMonth ?? 10000;

    if (!Number.isInteger(maxPerMonth) || maxPerMonth < 1) {
        throw new Error('maxPerMonth must be a positive integer');
    }

    const storeName =
        input.storeName ?? 'tdlr-historical-2021-2026';

    if (!/^[a-zA-Z0-9_-]{3,100}$/.test(storeName)) {
        throw new Error(
            'storeName must contain only letters, numbers, ' +
            'underscores and hyphens'
        );
    }

    const store = await Actor.openKeyValueStore(storeName);

    const session = await request(SEARCH_PAGE);
    const cookie = getCookie(session);

    const headers = {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type':
            'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: SEARCH_PAGE,
        ...(cookie ? { Cookie: cookie } : {}),
    };

    const periods = ranges(startDate, endDate);
    let total = 0;

    for (const [from, to] of periods) {
        const key =
            `MONTH_${from.replaceAll('-', '')}_` +
            `${to.replaceAll('-', '')}`;

        const existing = await store.getValue(key);

        if (
            existing?.complete &&
            Array.isArray(existing.records) &&
            existing.count === existing.records.length
        ) {
            console.log(
                `SKIP ${from} to ${to}: ` +
                `${existing.count} verified cached records`
            );
            total += existing.count;
            continue;
        }

        console.log(`FETCH ${from} to ${to}`);

        const records = await collect(
            from,
            to,
            headers,
            maxPerMonth
        );

        await store.setValue(key, {
            complete: true,
            from,
            to,
            count: records.length,
            fetchedAt: new Date().toISOString(),
            records,
        });

        total += records.length;

        console.log(
            `SAVED ${from} to ${to}: ` +
            `${records.length}; cumulative ${total}`
        );
    }

    const manifest = {
        complete: true,
        startDate,
        endDate,
        storeName,
        months: periods.length,
        totalRecords: total,
        finishedAt: new Date().toISOString(),
        note: 'Raw registrations only. Public-sector and ' +
              'asset-class enrichment are not yet applied.',
    };

    await store.setValue('MANIFEST', manifest);
    await Actor.setValue('BACKFILL_SUMMARY', manifest);
    await Actor.pushData(manifest);

    console.log(
        `BACKFILL COMPLETE: ${total} records ` +
        `across ${periods.length} monthly batches; ` +
        `named store ${storeName}`
    );

} catch (error) {
    console.error('BACKFILL FAILED:', error.message);

    await Actor.setValue('BACKFILL_ERROR', {
        message: error.message,
        at: new Date().toISOString(),
    });

    throw error;

} finally {
    await Actor.exit();
}
