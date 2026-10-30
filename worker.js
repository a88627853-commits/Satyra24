
const FEEDS = [
    {
        name: "Farmer.pl",
        url: "https://www.farmer.pl/fragments/rss/rss000.xml"
    }
];

const MAX_NEWS = 50;

function decodeXML(text) {
    return text
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) =>
            String.fromCodePoint(Number(n))
        )
        .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
            String.fromCodePoint(parseInt(n, 16))
        )
        .replace(/\s+/g, " ")
        .trim();
}

function getTag(xml, tag) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const match = xml.match(
        new RegExp(
            "<" + escaped + "(?:\\s[^>]*)?>([\\s\\S]*?)</" +
            escaped + "\\s*>",
            "i"
        )
    );

    return match ? decodeXML(match[1]) : "";
}

function getLink(xml) {
    const rssLink = getTag(xml, "link");

    if (rssLink) return rssLink;

    const atomLink = xml.match(
        /<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i
    );

    return atomLink ? atomLink[1] : "";
}

function parseFeed(xml, source) {
    const items = xml.match(
        /<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi
    ) || [];

    return items.map(item => {
        const title = getTag(item, "title");

        const description =
            getTag(item, "description") ||
            getTag(item, "summary");

        const link = getLink(item);

        const date =
            getTag(item, "pubDate") ||
            getTag(item, "published") ||
            getTag(item, "updated");

        const timestamp = Date.parse(date);

        if (!title || !link || !/^https?:\/\//i.test(link)) {
            return null;
        }

        return {
            title,
            description: description.slice(0, 500),
            url: link,
            source,
            published: Number.isFinite(timestamp)
                ? new Date(timestamp).toISOString()
                : null
        };
    }).filter(Boolean);
}

async function fetchFeed(feed) {
    const response = await fetch(feed.url, {
        headers: {
            "User-Agent": "SATYRA24 News Reader/1.0",
            "Accept": "application/rss+xml, application/xml, text/xml"
        },
        signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
        throw new Error(feed.name + " HTTP " + response.status);
    }

    return parseFeed(await response.text(), feed.name);
}

async function getNews() {
    const results = await Promise.allSettled(
        FEEDS.map(fetchFeed)
    );

    let news = [];

    results.forEach(result => {
        if (result.status === "fulfilled") {
            news.push(...result.value);
        }
    });

    const unique = new Map();

    news.forEach(article => {
        if (!unique.has(article.url)) {
            unique.set(article.url, article);
        }
    });

    return [...unique.values()]
        .sort((a, b) =>
            (Date.parse(b.published || 0) || 0) -
            (Date.parse(a.published || 0) || 0)
        )
        .slice(0, MAX_NEWS);
}

async function getPrices() {
    const response = await fetch(
        "https://benzynamapa.pl/data/stats_latest.json",
        {
            headers: {
                "Accept": "application/json"
            },
            signal: AbortSignal.timeout(10000)
        }
    );

    if (!response.ok) {
        throw new Error("BenzynaMAPA HTTP " + response.status);
    }

    const data = await response.json();

    if (!data.averages) {
        throw new Error("Nieprawidłowe dane cenowe");
    }

    const definitions = [
        { id: "pb95", name: "Benzyna Pb95", unit: "zł/l" },
        { id: "pb98", name: "Benzyna Pb98", unit: "zł/l" },
        { id: "on", name: "Diesel", unit: "zł/l" },
        { id: "lpg", name: "LPG", unit: "zł/l" }
    ];

    const fuels = definitions.map(item => {
        const value = Number(data.averages[item.id]);

        return {
            ...item,
            value: Number.isFinite(value) && value > 0
                ? value
                : null,
            trend7d: Number.isFinite(Number(data.trend_7d?.[item.id]))
                ? Number(data.trend_7d[item.id])
                : null
        };
    });

    return {
        portal: "SATYRA24",
        updated: data.last_updated || null,
        source: {
            name: "BenzynaMAPA.pl",
            url: "https://benzynamapa.pl"
        },
        fuels,
        stations: data.total_stations || null,
        grainMarket: {
            status: "not_connected",
            message: "Dane cen skupu zbóż wymagają osobnej integracji.",
            source: "Zintegrowany System Rolniczej Informacji Rynkowej",
            url: "https://zsrir.minrol.gov.pl/data"
        }
    };
}

function json(data, status = 200, cache = 900) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=0, s-maxage=${cache}`,
            "Access-Control-Allow-Origin": "*"
        }
    });
}

export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (request.method !== "GET") {
            return json({ error: "Method not allowed" }, 405);
        }

        if (url.pathname === "/health") {
            return json({
                status: "online",
                service: "SATYRA24 API"
            });
        }

        if (url.pathname === "/api/news") {
            const news = await getNews();

            return json({
                portal: "SATYRA24",
                category: "Rolnictwo",
                count: news.length,
                updated: new Date().toISOString(),
                articles: news
            });
        }

        if (url.pathname === "/api/prices") {
            try {
                return json(await getPrices(), 200, 3600);
            } catch (error) {
                return json({
                    portal: "SATYRA24",
                    error: "Nie udało się pobrać cen paliw",
                    details: error.message
                }, 502, 60);
            }
        }

        return json({ error: "Not found" }, 404);
    }
};
