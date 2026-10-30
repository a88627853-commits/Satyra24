import { DurableObject } from "cloudflare:workers";

const FEEDS = [
    {
        name: "Farmer.pl",
        url: "https://www.farmer.pl/fragments/rss/rss000.xml"
    }
];

const MAX_NEWS = 50;
const BDL_API = "https://bdl.stat.gov.pl/api/v1";
const BDL_SUBJECT = "P2967";
const BDL_POLAND_ID = "000000000000";
const MARKET_CACHE_MS = 6 * 60 * 60 * 1000;

let marketCache = null;
let marketCacheTime = 0;

const MONTHS = [
    { number: 1, names: ["styczen", "stycznia", "january", "jan"] },
    { number: 2, names: ["luty", "lutego", "february", "feb"] },
    { number: 3, names: ["marzec", "marca", "march", "mar"] },
    { number: 4, names: ["kwiecien", "kwietnia", "april", "apr"] },
    { number: 5, names: ["maj", "maja", "may"] },
    { number: 6, names: ["czerwiec", "czerwca", "june", "jun"] },
    { number: 7, names: ["lipiec", "lipca", "july", "jul"] },
    { number: 8, names: ["sierpien", "sierpnia", "august", "aug"] },
    { number: 9, names: ["wrzesien", "wrzesnia", "september", "sept"] },
    { number: 10, names: ["pazdziernik", "pazdziernika", "october", "oct"] },
    { number: 11, names: ["listopad", "listopada", "november", "nov"] },
    { number: 12, names: ["grudzien", "grudnia", "december", "dec"] }
];

// GUS BDL P2967: monthly average procurement prices.
// divisor converts the published unit to the calculator unit.
const PRODUCTS = [
    { id: "wheat", name: "Pszenica", keys: ["pszenica", "wheat"], unit: "kg", sourceUnit: "zł/100 kg", divisor: 100 },
    { id: "rye", name: "Żyto", keys: ["zyto", "rye"], unit: "kg", sourceUnit: "zł/100 kg", divisor: 100 },
    { id: "barley", name: "Jęczmień", keys: ["jeczmien", "barley"], unit: "kg", sourceUnit: "zł/100 kg", divisor: 100 },
    { id: "triticale", name: "Pszenżyto", keys: ["pszenzyto", "triticale"], unit: "kg", sourceUnit: "zł/100 kg", divisor: 100 },
    { id: "oats", name: "Owies", keys: ["owies", "oats"], unit: "kg", sourceUnit: "zł/100 kg", divisor: 100 },
    { id: "corn", name: "Kukurydza", keys: ["kukurydza", "maize", "corn"], unit: "kg", sourceUnit: "zł/100 kg", divisor: 100 },
    { id: "potatoes", name: "Ziemniaki", keys: ["ziemniaki", "potatoes"], unit: "kg", sourceUnit: "zł/100 kg", divisor: 100 },
    { id: "milk", name: "Mleko krowie", keys: ["mleko krowie", "cows milk", "milk"], unit: "l", sourceUnit: "zł/100 l", divisor: 100 },
    { id: "cattle", name: "Bydło rzeźne", keys: ["bydlo", "cattle for slaughter"], unit: "kg żywej wagi", sourceUnit: "zł/kg żywej wagi", divisor: 1 },
    { id: "pigs", name: "Trzoda chlewna", keys: ["trzoda chlewna", "swinie", "swine", "pigs for slaughter"], unit: "kg żywej wagi", sourceUnit: "zł/kg żywej wagi", divisor: 1 },
    { id: "poultry", name: "Drób rzeźny", keys: ["drob rzezny", "poultry for slaughter"], unit: "kg żywej wagi", sourceUnit: "zł/kg żywej wagi", divisor: 1 }
];

function decodeXML(text) {
    return String(text || "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/\s+/g, " ")
        .trim();
}

function getTag(xml, tag) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = xml.match(new RegExp(
        "<" + escaped + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + escaped + "\\s*>",
        "i"
    ));
    return match ? decodeXML(match[1]) : "";
}

function getLink(xml) {
    const rssLink = getTag(xml, "link");
    if (rssLink) return rssLink;

    const atomLink = xml.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?\s*>/i);
    return atomLink ? atomLink[1] : "";
}

function parseFeed(xml, source) {
    const items = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi) || [];

    return items.map(item => {
        const title = getTag(item, "title");
        const description = getTag(item, "description") || getTag(item, "summary");
        const link = getLink(item);
        const date = getTag(item, "pubDate") || getTag(item, "published") || getTag(item, "updated");
        const timestamp = Date.parse(date);

        if (!title || !link || !/^https?:\/\//i.test(link)) return null;

        return {
            title,
            description: description.slice(0, 900),
            url: link,
            source,
            published: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
            image: null
        };
    }).filter(Boolean);
}

async function fetchFeed(feed) {
    const response = await fetch(feed.url, {
        headers: {
            "User-Agent": "SATYRA24 News Reader/1.0",
            "Accept": "application/rss+xml, application/xml, text/xml"
        },
        signal: AbortSignal.timeout(12000)
    });

    if (!response.ok) throw new Error(feed.name + " HTTP " + response.status);
    return parseFeed(await response.text(), feed.name);
}

async function getNews() {
    const results = await Promise.allSettled(FEEDS.map(fetchFeed));
    const news = [];

    for (const result of results) {
        if (result.status === "fulfilled") news.push(...result.value);
    }

    const unique = new Map();
    for (const article of news) {
        if (!unique.has(article.url)) unique.set(article.url, article);
    }

    return [...unique.values()]
        .sort((a, b) => (Date.parse(b.published || 0) || 0) - (Date.parse(a.published || 0) || 0))
        .slice(0, MAX_NEWS);
}

function normalizeText(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

function findMonth(text) {
    const normalized = normalizeText(text);
    for (const month of MONTHS) {
        if (month.names.some(name => new RegExp("(^|[^a-z])" + name + "[a-z]*([^a-z]|$)").test(normalized))) {
            return month.number;
        }
    }
    return null;
}

async function bdlJSON(path) {
    const response = await fetch(BDL_API + path, {
        headers: { "Accept": "application/vnd.api+json, application/json" },
        signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
        throw new Error("GUS BDL HTTP " + response.status);
    }

    return response.json();
}

async function getBDLVariables() {
    const all = [];

    for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({
            "subject-id": BDL_SUBJECT,
            level: "2",
            page: String(page),
            "page-size": "100",
            format: "jsonapi",
            lang: "pl"
        });

        const payload = await bdlJSON("/variables/search?" + params.toString());
        const records = Array.isArray(payload.data) ? payload.data : [];
        all.push(...records);

        if (records.length < 100) break;
    }

    if (!all.length) throw new Error("GUS BDL nie zwrócił listy zmiennych cenowych.");

    return all.map(record => {
        const attributes = record.attributes || {};
        const label = [
            attributes.n1,
            attributes.n2,
            attributes.name,
            attributes.description
        ].filter(Boolean).join(" / ");

        return {
            id: String(record.id || attributes.id || ""),
            label,
            month: findMonth(label)
        };
    }).filter(item => item.id && item.month);
}

async function getBDLData(variableIds) {
    const uniqueIds = [...new Set(variableIds)];
    const all = [];

    for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams();
        uniqueIds.forEach(id => params.append("var-id", id));
        params.set("page", String(page));
        params.set("page-size", "100");
        params.set("format", "jsonapi");
        params.set("lang", "pl");

        const payload = await bdlJSON(
            "/data/by-unit/" + BDL_POLAND_ID + "?" + params.toString()
        );

        const records = Array.isArray(payload.data) ? payload.data : [];
        all.push(...records);
        if (records.length < 100) break;
    }

    return all;
}

function extractVariableValues(records, knownIds) {
    const result = new Map();

    function add(id, values) {
        const key = String(id || "");
        if (!knownIds.has(key) || !Array.isArray(values)) return;
        const existing = result.get(key) || [];
        existing.push(...values);
        result.set(key, existing);
    }

    for (const record of records) {
        const attributes = record.attributes || {};
        const directId = record.id || attributes.varId || attributes.variableId || attributes.var_id;
        add(directId, attributes.values || record.values);

        const values = attributes.values || record.values;
        if (Array.isArray(values)) {
            for (const value of values) {
                const nestedId = value.varId || value.variableId || value.var_id || value.variable_id;
                if (nestedId) add(nestedId, [value]);
            }
        }
    }

    return result;
}

async function getAgriculturalPrices() {
    if (marketCache && Date.now() - marketCacheTime < MARKET_CACHE_MS) {
        return marketCache;
    }

    const variables = await getBDLVariables();
    const candidatesByProduct = new Map();

    for (const product of PRODUCTS) {
        const candidates = variables.filter(variable => {
            const text = normalizeText(variable.label);
            return product.keys.some(key => text.includes(normalizeText(key)));
        }).sort((a, b) => b.month - a.month);

        candidatesByProduct.set(product.id, candidates);
    }

    const allIds = [...new Set(
        [...candidatesByProduct.values()].flat().map(item => item.id)
    )];

    if (!allIds.length) {
        throw new Error("Nie udało się dopasować produktów do danych GUS BDL.");
    }

    const rows = await getBDLData(allIds);
    const valuesById = extractVariableValues(rows, new Set(allIds));
    const monthNames = [
        "styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec",
        "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"
    ];

    const products = [];

    for (const product of PRODUCTS) {
        const candidates = candidatesByProduct.get(product.id) || [];
        let best = null;

        for (const candidate of candidates) {
            const values = valuesById.get(candidate.id) || [];

            for (const item of values) {
                const year = Number(item.year);
                const value = Number(item.val ?? item.value);

                if (!Number.isFinite(year) || !Number.isFinite(value) || value <= 0) continue;

                const dateRank = year * 12 + candidate.month;
                if (!best || dateRank > best.dateRank) {
                    best = {
                        value,
                        year,
                        month: candidate.month,
                        dateRank
                    };
                }
            }
        }

        if (!best) continue;

        products.push({
            id: product.id,
            name: product.name,
            price: best.value,
            publishedUnit: product.sourceUnit,
            unitPrice: best.value / product.divisor,
            unit: product.unit,
            period: monthNames[best.month - 1] + " " + best.year,
            category: "Średnia cena skupu"
        });
    }

    const result = {
        portal: "SATYRA24",
        fetchedAt: new Date().toISOString(),
        source: {
            name: "GUS - Bank Danych Lokalnych, temat P2967",
            url: "https://bdl.stat.gov.pl/bdl/dane/podgrup/temat#P2967",
            license: "CC BY 4.0"
        },
        products
    };

    if (!products.length) {
        throw new Error("GUS odpowiedział, ale nie udało się odczytać wartości cen. Sprawdź odpowiedź API BDL.");
    }

    marketCache = result;
    marketCacheTime = Date.now();
    return result;
}

function json(data, status = 200, cacheSeconds = 900) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": cacheSeconds === 0
                ? "no-store"
                : `public, max-age=0, s-maxage=${cacheSeconds}`,
            "Access-Control-Allow-Origin": "*"
        }
    });
}

export class VisitorCounter extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);

        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS site_counter (
                name TEXT PRIMARY KEY,
                value INTEGER NOT NULL DEFAULT 0
            )
        `);

        this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO site_counter (name, value) VALUES ('visits', 0)"
        );
    }

    async fetch(request) {
        if (request.method === "POST") {
            const row = this.ctx.storage.sql.exec(
                "UPDATE site_counter SET value = value + 1 WHERE name = 'visits' RETURNING value"
            ).one();

            return Response.json({ visits: row.value }, {
                headers: { "Cache-Control": "no-store" }
            });
        }

        if (request.method === "GET") {
            const row = this.ctx.storage.sql.exec(
                "SELECT value FROM site_counter WHERE name = 'visits'"
            ).one();

            return Response.json({ visits: row.value }, {
                headers: { "Cache-Control": "no-store" }
            });
        }

        return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === "/api/visits") {
            if (request.method !== "GET" && request.method !== "POST") {
                return json({ error: "Method not allowed" }, 405, 0);
            }

            try {
                const id = env.VISITOR_COUNTER.idFromName("satyra24-global-counter");
                const counter = env.VISITOR_COUNTER.get(id);
                const response = await counter.fetch(
                    "https://visitor-counter.internal/count",
                    { method: request.method }
                );
                const result = await response.json();

                if (!response.ok || !Number.isSafeInteger(result.visits)) {
                    throw new Error("Nieprawidłowa odpowiedź licznika.");
                }

                return json({
                    portal: "SATYRA24",
                    visits: result.visits
                }, 200, 0);
            } catch (error) {
                return json({
                    portal: "SATYRA24",
                    error: "Licznik odwiedzin jest chwilowo niedostępny.",
                    details: error.message
                }, 502, 0);
            }
        }

        if (request.method !== "GET") {
            return json({ error: "Method not allowed" }, 405);
        }

        if (url.pathname === "/health") {
            return json({ status: "online", service: "SATYRA24 API" });
        }

        if (url.pathname === "/api/news") {
            try {
                const articles = await getNews();
                return json({
                    portal: "SATYRA24",
                    category: "Rolnictwo",
                    count: articles.length,
                    updated: new Date().toISOString(),
                    articles
                });
            } catch (error) {
                return json({
                    portal: "SATYRA24",
                    error: "Nie udało się pobrać wiadomości",
                    details: error.message,
                    articles: []
                }, 502, 60);
            }
        }

        if (url.pathname === "/api/prices") {
            try {
                return json(await getAgriculturalPrices(), 200, 3600);
            } catch (error) {
                return json({
                    portal: "SATYRA24",
                    error: "Nie udało się pobrać cen produktów rolnych",
                    details: error.message,
                    products: []
                }, 502, 60);
            }
        }

        return json({ error: "Not found" }, 404);
    }
};
