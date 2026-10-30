
const FEEDS = [
    {
        name: "Farmer.pl",
        url: "https://www.farmer.pl/fragments/rss/rss000.xml"
    }
];

const MAX_NEWS = 50;
const CACHE_SECONDS = 900;

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
        new RegExp("<" + escaped + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + escaped + "\\s*>", "i")
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
            description: description.slice(0, 250),
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
        throw new Error(
            feed.name + " HTTP " + response.status
        );
    }

    const xml = await response.text();

    return parseFeed(xml, feed.name);
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

function json(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=0, s-maxage=900",
            "Access-Control-Allow-Origin": "*"
        }
    });
}

export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (request.method !== "GET") {
            return json({
                error: "Method not allowed"
            }, 405);
        }

        if (url.pathname === "/health") {
            return json({
                status: "online",
                service: "SATYRA24 API"
            });
        }

        if (url.pathname !== "/api/news") {
            return json({
                error: "Not found"
            }, 404);
        }

        try {
            const news = await getNews();

            return json({
                portal: "SATYRA24",
                category: "Rolnictwo",
                count: news.length,
                updated: new Date().toISOString(),
                articles: news
            });

        } catch (error) {
            return json({
                portal: "SATYRA24",
                error: "Nie udało się pobrać wiadomości",
                details: error.message,
                articles: []
            }, 502);
        }
    }
};
