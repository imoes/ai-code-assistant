import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { Logger } from './logger';

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}

export interface SearchResponse {
    query: string;
    results: SearchResult[];
    abstract?: string;    // Instant Answer falls vorhanden
    answer?: string;      // Direkte Antwort (z.B. Währungsrechner)
    /** Why no provider delivered a hit – for a usable report */
    problems?: string[];
}

/**
 * WebSearcher: DuckDuckGo Instant Answer API + HTML-Fallback.
 *
 * Primary: https://api.duckduckgo.com/?q=<query>&format=json
 *   → Liefert Abstract, Answer, RelatedTopics
 * Fallback: https://html.duckduckgo.com/html/ POST
 * → Parsed result__title / result__snippet from HTML
 */
export class WebSearcher {
    private static instance: WebSearcher;
    private logger = Logger.getInstance();

    static getInstance(): WebSearcher {
        if (!WebSearcher.instance) {
            WebSearcher.instance = new WebSearcher();
        }
        return WebSearcher.instance;
    }

    /**
     * Search through a chain of providers.
     *
     * Why a chain and not a provider: keyless search is not
     * reliably. The DuckDuckGo Instant Answer API responds under load with
     * HTTP 202 and empty fields, the HTML endpoint returns after a few
     * Requests no longer, and public SearXNG instances respond with
     * 403 or 429. Therefore: a configured provider with a key first
     * (reliable), the keyless paths after that (better than nothing).
     *
     * Leads to no hits, the result clearly indicates that the assistant
     * instead, you should use `web_fetch` with a specific address – a
     * An empty result list without a hint leaves the model to only guess.
     */
    async search(query: string, maxResults = 5): Promise<SearchResponse> {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        const provider = config.get<string>('searchProvider', 'auto');
        const apiKey = config.get<string>('searchApiKey', '').trim();
        const endpoint = config.get<string>('searchEndpoint', '').trim();

        this.logger.info(`Web-Suche: "${query}" (Anbieter: ${provider})`);

        // Set the order: explicitly chosen provider alone,
        // otherwise all available in order of reliability.
        const chain: string[] = provider !== 'auto'
            ? [provider]
            : [
                ...(apiKey ? ['tavily', 'brave', 'google'] : []),
                ...(endpoint ? ['searxng'] : []),
                'keyless'
            ];

        const problems: string[] = [];

        for (const name of chain) {
            try {
                const result = await this.runProvider(name, query, maxResults, apiKey, endpoint);
                if (result && (result.results.length > 0 || result.abstract || result.answer)) {
                    this.logger.info(`Web-Suche (${name}): ${result.results.length} Ergebnis(se)`);
                    return result;
                }
                // Pass through the justifications of the sub-queries. Otherwise, it stands
                // outside only "keyless: no hits", and neither user nor
                // Model experienced, whether blocked, throttled, or truly empty.
                if (result?.problems?.length) problems.push(...result.problems);
                else problems.push(`${name}: keine Treffer`);
                this.logger.warn(`Web-Suche (${name}): keine Treffer`);
            } catch (err) {
                const msg = (err as Error).message;
                problems.push(`${name}: ${msg}`);
                this.logger.warn(`Web-Suche (${name}) fehlgeschlagen: ${msg}`);
            }
        }

        return { query, results: [], problems };
    }

    /** Query a single provider. */
    private async runProvider(
        name: string,
        query: string,
        maxResults: number,
        apiKey: string,
        endpoint: string
    ): Promise<SearchResponse | null> {
        switch (name) {
            case 'tavily':
                if (!apiKey) throw new Error('kein API-Key gesetzt');
                return this.searchTavily(query, maxResults, apiKey);
            case 'brave':
                if (!apiKey) throw new Error('kein API-Key gesetzt');
                return this.searchBrave(query, maxResults, apiKey);
            case 'google':
                if (!apiKey) throw new Error('kein API-Key gesetzt');
                if (!endpoint) throw new Error('keine Such-ID (cx) in searchEndpoint');
                return this.searchGoogle(query, maxResults, apiKey, endpoint);
            case 'searxng':
                if (!endpoint) throw new Error('keine Instanz-Adresse in searchEndpoint');
                return this.searchSearxng(query, maxResults, endpoint);
            case 'duckduckgo': {
                // First the instant-answer API (sometimes provides a direct
                // answer), then the HTML page.
                try {
                    const instant = await this.searchInstantAnswer(query, maxResults);
                    if (instant.results.length > 0 || instant.abstract || instant.answer) return instant;
                } catch { /* weiter zum HTML-Weg */ }
                return this.searchHtml(query, maxResults);
            }
            case 'ddglite':
                return this.searchDuckDuckGoLite(query, maxResults);
            case 'stackexchange':
                return this.searchStackExchange(query, maxResults);
            case 'wikipedia':
                return this.searchWikipedia(query, maxResults);
            case 'keyless':
                return this.searchKeyless(query, maxResults);
            default:
                throw new Error(`unbekannter Anbieter "${name}"`);
        }
    }

    /**
     * Tavily – designed for AI usage: provides text excerpts instead of just links.
     * Free quota, key required.
     */
    private async searchTavily(query: string, maxResults: number, apiKey: string): Promise<SearchResponse> {
        const raw = await this.httpPostJson('https://api.tavily.com/search', {
            api_key: apiKey,
            query,
            max_results: maxResults,
            search_depth: 'basic',
            include_answer: true
        });
        const data = JSON.parse(raw);
        return {
            query,
            answer: data.answer || undefined,
            results: (data.results ?? []).slice(0, maxResults).map((r: {
                title?: string; url?: string; content?: string;
            }) => ({
                title: r.title ?? '',
                url: r.url ?? '',
                snippet: (r.content ?? '').replace(/\s+/g, ' ').trim()
            })).filter((r: SearchResult) => r.url)
        };
    }

    /** Brave Search API – Key required, free quota. */
    private async searchBrave(query: string, maxResults: number, apiKey: string): Promise<SearchResponse> {
        const url = `https://api.search.brave.com/res/v1/web/search`
            + `?q=${encodeURIComponent(query)}&count=${maxResults}`;
        const raw = await this.httpGet(url, 5, {
            'X-Subscription-Token': apiKey,
            'Accept': 'application/json'
        });
        const data = JSON.parse(raw);
        return {
            query,
            results: (data.web?.results ?? []).slice(0, maxResults).map((r: {
                title?: string; url?: string; description?: string;
            }) => ({
                title: r.title ?? '',
                url: r.url ?? '',
                snippet: this.stripHtml(r.description ?? '').replace(/\s+/g, ' ').trim()
            })).filter((r: SearchResult) => r.url)
        };
    }

    /** Google Programmable Search – Key and Search ID (cx) required. */
    private async searchGoogle(
        query: string, maxResults: number, apiKey: string, cx: string
    ): Promise<SearchResponse> {
        const url = `https://www.googleapis.com/customsearch/v1`
            + `?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}`
            + `&q=${encodeURIComponent(query)}&num=${Math.min(10, maxResults)}`;
        const raw = await this.httpGet(url);
        const data = JSON.parse(raw);
        return {
            query,
            results: (data.items ?? []).slice(0, maxResults).map((r: {
                title?: string; link?: string; snippet?: string;
            }) => ({
                title: r.title ?? '',
                url: r.link ?? '',
                snippet: (r.snippet ?? '').replace(/\s+/g, ' ').trim()
            })).filter((r: SearchResult) => r.url)
        };
    }

    // ──────────────────────────────────────────────────────────────────────
    // Keyless search: multiple independent sources simultaneously
    // ──────────────────────────────────────────────────────────────────────

    /**
     * Search without key – across multiple sources in parallel.
     *
     * There is no free, unlimited, general web search. Every path is
     * either a provider with a quota, or he scrapes an HTML page
     * and is blocked from a certain volume. A separate SearXNG helps
     * not included: it merely shifts the scraping, the locks of the surveyed
     * Search engines are still considered. And the Bing Search API has been since the
     * 11. August 2025 abgeschaltet.
     *
     * What helps is the independence of the sources. The following are asked simultaneously:
     *
     * - DuckDuckGo HTML and DuckDuckGo Lite – two separate interfaces
     * - Stack Exchange – official API, no key required, 300 requests/day per IP
     * - Wikipedia (MediaWiki) – official API, no key required, high limits
     *
     * If one source fails, the others take over. The results are passed through the
     * Addresses merged to prevent the same page from appearing twice.
     * For a known address, `web_fetch` remains the reliable method – the
     * has no quota at all.
     */
    private async searchKeyless(query: string, maxResults: number): Promise<SearchResponse> {
        type Attempt = { name: string; response: SearchResponse | null; error: string };

        const attempt = async (name: string, run: () => Promise<SearchResponse>): Promise<Attempt> => {
            try {
                const r = await run();
                this.logger.info(`Web-Suche (${name}): ${r.results.length} Treffer`);
                return { name, response: r, error: '' };
            } catch (err) {
                const msg = (err as Error).message;
                this.logger.warn(`Web-Suche (${name}) fehlgeschlagen: ${msg}`);
                return { name, response: null, error: msg };
            }
        };

        // DuckDuckGo counts as ONE source: first /html/, only on failure the
        // Lite page. Asking both simultaneously doubles the load on
        // the same service and leads to a ban faster – in the test run
        // DuckDuckGo went silent after the fifth consecutive request.
        const duckduckgo = async (): Promise<Attempt> => {
            const html = await attempt('duckduckgo', () => this.searchHtml(query, maxResults));
            if (html.response && html.response.results.length > 0) return html;
            const lite = await attempt('ddglite', () => this.searchDuckDuckGoLite(query, maxResults));
            if (lite.response && lite.response.results.length > 0) return lite;
            return html.response ? lite : html;
        };

        const first = await Promise.all([
            duckduckgo(),
            attempt('stackexchange', () => this.searchStackExchange(query, maxResults))
        ]);

        const merge = (attempts: Attempt[]) => {
            const seen = new Set<string>();
            const out: SearchResult[] = [];
            const problems: string[] = [];
            let answer: string | undefined;
            for (const a of attempts) {
                if (!a.response) { problems.push(`${a.name}: ${a.error}`); continue; }
                if (a.response.results.length === 0) problems.push(`${a.name}: keine Treffer`);
                if (!answer && a.response.answer) answer = a.response.answer;
                for (const r of a.response.results) {
                    const key = r.url.replace(/[#?].*$/, '').replace(/\/+$/, '');
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push(r);
                }
            }
            return { results: out, problems, answer };
        };

        let { results, problems, answer } = merge(first);

        // Wikipedia only if nothing else came. For "typescript satisfies
        // operator" it provided the article "Modulo" in the test run – as
        // supplement it is noise, as last resort better than nothing.
        if (results.length === 0) {
            const fallback = await attempt('wikipedia', () => this.searchWikipedia(query, maxResults));
            const second = merge([fallback]);
            results = second.results;
            problems = [...problems, ...second.problems];
            answer = answer ?? second.answer;
        }

        return {
            query,
            answer,
            results: results.slice(0, maxResults),
            problems: results.length === 0 ? problems : undefined
        };
    }

    /**
     * DuckDuckGo Lite – the same search, different interface.
     *
     * A second, independent address with its own designation: locks or
     * empties one interface, the other often still does. The Lite page
     * is a table with `result-link` and `result-snippet`, each in
     * simple quotes – not the same markup as /html/.
     */
    private async searchDuckDuckGoLite(query: string, maxResults: number): Promise<SearchResponse> {
        const raw = await this.httpPost(
            'https://lite.duckduckgo.com/lite/',
            `q=${encodeURIComponent(query)}&kl=wt-wt`
        );
        return { query, results: this.parseDuckDuckGoLiteHtml(raw, maxResults) };
    }

    /** Read hits from the Lite page – separate from the network call, so it can be verified. */
    private parseDuckDuckGoLiteHtml(raw: string, maxResults: number): SearchResult[] {
        type Hit = { pos: number; url: string; title: string };
        const titles: Hit[] = [];
        const snippets: { pos: number; text: string }[] = [];

        const titlePattern = /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g;
        let m: RegExpExecArray | null;
        while ((m = titlePattern.exec(raw)) !== null) {
            titles.push({ pos: m.index, url: this.decodeRedirectUrl(m[1]), title: this.stripHtml(m[2]) });
        }

        const snippetPattern = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
        while ((m = snippetPattern.exec(raw)) !== null) {
            snippets.push({ pos: m.index, text: this.stripHtml(m[1]) });
        }

        // On the Lite page, the excerpt appears BEFORE the next title, but after
        // the own one – pairing is done based on position, as with /html/.
        const results: SearchResult[] = [];
        for (let i = 0; i < titles.length && results.length < maxResults; i++) {
            const t = titles[i];
            const next = titles[i + 1]?.pos ?? Infinity;
            const own = snippets.find(s => s.pos > t.pos && s.pos < next)
                ?? snippets.find(s => s.pos < t.pos && (i === 0 || s.pos > titles[i - 1].pos));
            if (!t.url || !t.title) continue;
            results.push({ title: t.title, url: t.url, snippet: own?.text ?? '' });
        }

        return results;
    }

    /**
     * Stack Exchange – official API, usable without a key.
     *
     * Without a key, 300 requests per day per IP apply; this is for a
     * Plenty of assistants with a handful of searches per task. And it is
     * a real API: no HTML markup that changes tomorrow.
     *
     * For programming questions, this is often the better source than a general
     * Search engine – title and score say more than a text snippet.
     */
    private async searchStackExchange(query: string, maxResults: number): Promise<SearchResponse> {
        const url = 'https://api.stackexchange.com/2.3/search/advanced'
            + `?order=desc&sort=relevance&site=stackoverflow&pagesize=${Math.max(1, maxResults)}`
            + `&q=${encodeURIComponent(query)}`;
        const raw = await this.httpGet(url, 5, { 'Accept': 'application/json' });
        return { query, results: this.mapStackExchange(JSON.parse(raw), maxResults) };
    }

    /** Translate the Stack Exchange API response into hits. */
    private mapStackExchange(data: {
        error_message?: string;
        items?: {
            title?: string; link?: string; score?: number;
            answer_count?: number; is_answered?: boolean; tags?: string[];
        }[];
    }, maxResults: number): SearchResult[] {
        if (data.error_message) throw new Error(String(data.error_message));

        return (data.items ?? []).slice(0, maxResults).map((it: {
            title?: string; link?: string; score?: number;
            answer_count?: number; is_answered?: boolean; tags?: string[];
        }) => ({
            title: this.stripHtml(it.title ?? ''),
            url: it.link ?? '',
            // The text excerpt is being built: the API returns nothing without a filter
            // Question text, but the score and answer count say enough about it,
            // whether opening it is worthwhile.
            snippet: `Stack Overflow · ${it.score ?? 0} Punkte · `
                + `${it.answer_count ?? 0} Antwort(en)`
                + `${it.is_answered ? ', akzeptiert' : ''}`
                + `${it.tags?.length ? ' · ' + it.tags.slice(0, 5).join(', ') : ''}`
        })).filter((r: SearchResult) => r.url);
    }

    /**
     * Wikipedia on the MediaWiki API – keyless and official.
     *
     * For terms and procedures ("What is a recursive-descent parser") that
     * most reliable keyless source ever. For programming details
     * it is not suitable, therefore it is placed at the end in the merge.
     */
    /**
     * Select the Wikipedia language output for the search query.
     *
     * Decide on umlauts and German function words. An uppercase letter is
     * not as a feature: "Typescript satisfies operator" ended up on
     * de.wikipedia.org.
     */
    private wikipediaLanguage(query: string): 'de' | 'en' {
        if (/[äöüßÄÖÜ]/.test(query)) return 'de';
        if (/\b(?:der|die|das|den|dem|und|oder|wie|was|wer|ist|sind|nicht|kein|eine|einen|einem|mit|von|für|auf|man|werden|wird)\b/i
            .test(query)) return 'de';
        return 'en';
    }

    private async searchWikipedia(query: string, maxResults: number): Promise<SearchResponse> {
        const lang = this.wikipediaLanguage(query);

        // Remove question formulas: "how does a recursive descent
        // parser" finds nothing in full-text search, "recursive descent
        // parser" does.
        const terms = query
            .replace(/^\s*(?:wie|was|wer|wo|warum|wieso|weshalb|welche[srn]?)\b/i, '')
            .replace(/\b(?:funktioniert|funktionieren|bedeutet|macht|ist|sind|man|ein|eine|einen|der|die|das|und|von|mit|für|how|does|do|is|are|the|a|an|what)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim() || query;

        const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search`
            + `&srsearch=${encodeURIComponent(terms)}&srlimit=${Math.max(1, maxResults)}`
            + '&format=json&origin=*';
        const raw = await this.httpGet(url, 5, { 'Accept': 'application/json' });
        const data = JSON.parse(raw);

        const results: SearchResult[] = (data.query?.search ?? []).slice(0, maxResults).map((s: {
            title?: string; snippet?: string;
        }) => ({
            title: `${s.title ?? ''} (Wikipedia)`,
            url: `https://${lang}.wikipedia.org/wiki/`
                + encodeURIComponent(String(s.title ?? '').replace(/ /g, '_')),
            snippet: this.stripHtml(s.snippet ?? '')
        })).filter((r: SearchResult) => r.title.length > 12);

        return { query, results };
    }

    /**
     * SearXNG – only usable with your own instance: public instances
     * respond with 403 or 429.
     *
     * Important: a fresh instance does not output JSON. In `settings.yml`
     * `search.formats` must also contain `json`, otherwise it responds with 403.
     * And unboundedness does not bring its own instance: SearXNG queries
     * Google, Bing, and DuckDuckGo for you – their restrictions still apply.
     */
    private async searchSearxng(
        query: string, maxResults: number, base: string
    ): Promise<SearchResponse> {
        const root = base.replace(/\/+$/, '');
        const url = `${root}/search?q=${encodeURIComponent(query)}&format=json`;
        const raw = await this.httpGet(url, 5, { 'Accept': 'application/json' });

        // A fresh instance does not output JSON and responds with the
        // HTML page. The message must indicate what to do – otherwise one looks
        // for the error in the client instead of in settings.yml.
        let data: {
            answers?: string[];
            results?: { title?: string; url?: string; content?: string }[];
        };
        try {
            data = JSON.parse(raw);
        } catch {
            throw new Error(
                'Instanz liefert kein JSON. In settings.yml unter search.formats '
                + 'auch "json" eintragen (Standard ist nur "html") und neu starten.'
            );
        }
        return {
            query,
            answer: (data.answers ?? [])[0] || undefined,
            results: (data.results ?? []).slice(0, maxResults).map((r: {
                title?: string; url?: string; content?: string;
            }) => ({
                title: r.title ?? '',
                url: r.url ?? '',
                snippet: (r.content ?? '').replace(/\s+/g, ' ').trim()
            })).filter((r: SearchResult) => r.url)
        };
    }

    // ──────────────────────────────────────────────────────────────────────
    // DuckDuckGo Instant Answer API
    // ──────────────────────────────────────────────────────────────────────

    private async searchInstantAnswer(query: string, maxResults: number): Promise<SearchResponse> {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=ai-code-assistant`;
        const raw = await this.httpGet(url);
        const data = JSON.parse(raw);

        const results: SearchResult[] = [];

        // RelatedTopics → Suchergebnisse
        const topics: unknown[] = data.RelatedTopics ?? [];
        for (const topic of topics) {
            if (results.length >= maxResults) break;
            if (typeof topic !== 'object' || topic === null) continue;
            const t = topic as Record<string, unknown>;

            // Flaches Topic
            if (typeof t.Text === 'string' && typeof t.FirstURL === 'string') {
                results.push({
                    title: this.extractTitle(t.FirstURL as string),
                    url: t.FirstURL as string,
                    snippet: this.stripHtml(t.Text as string)
                });
            }
            // Topics-Gruppe
            if (Array.isArray(t.Topics)) {
                for (const sub of t.Topics) {
                    if (results.length >= maxResults) break;
                    if (typeof sub !== 'object' || sub === null) continue;
                    const s = sub as Record<string, unknown>;
                    if (typeof s.Text === 'string' && typeof s.FirstURL === 'string') {
                        results.push({
                            title: this.extractTitle(s.FirstURL as string),
                            url: s.FirstURL as string,
                            snippet: this.stripHtml(s.Text as string)
                        });
                    }
                }
            }
        }

        // Results (offizielle Link-Ergebnisse)
        for (const r of (data.Results ?? []) as Record<string, unknown>[]) {
            if (results.length >= maxResults) break;
            if (typeof r.Text === 'string' && typeof r.FirstURL === 'string') {
                results.push({
                    title: this.extractTitle(r.FirstURL as string),
                    url: r.FirstURL as string,
                    snippet: this.stripHtml(r.Text as string)
                });
            }
        }

        return {
            query,
            results,
            abstract: data.AbstractText ? this.stripHtml(data.AbstractText) : undefined,
            answer: data.Answer ? this.stripHtml(data.Answer) : undefined
        };
    }

    // ──────────────────────────────────────────────────────────────────────
    // HTML-Scraping Fallback
    // ──────────────────────────────────────────────────────────────────────

    private async searchHtml(query: string, maxResults: number): Promise<SearchResponse> {
        const postData = `q=${encodeURIComponent(query)}&b=&kl=de-de`;
        const raw = await this.httpPost('https://html.duckduckgo.com/html/', postData);
        return { query, results: this.parseDuckDuckGoHtml(raw, maxResults) };
    }

    /**
     * Read matches from the HTML response.
     *
     * Do not cross blocks: the page nests multiple elements, whose
     * All class names start with "result" (`result__extras`, `result__body`).
     * A block pattern thus cuts every hit into pieces, and the
     * Excerpts ended up in the wrong part – the AI only received titles and links,
     * with which it cannot do anything.
     *
     * Instead: Title links and excerpts individually in document order
     * collect and pair them based on their position.
     */
    private parseDuckDuckGoHtml(raw: string, maxResults: number): SearchResult[] {
        type Hit = { pos: number; url: string; title: string };
        const titles: Hit[] = [];
        const snippets: { pos: number; text: string }[] = [];

        const titlePattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        let m: RegExpExecArray | null;
        while ((m = titlePattern.exec(raw)) !== null) {
            const url = this.decodeRedirectUrl(m[1]);
            const title = this.stripHtml(m[2]).trim();
            if (url && title) titles.push({ pos: m.index, url, title });
        }

        const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
        while ((m = snippetPattern.exec(raw)) !== null) {
            const text = this.stripHtml(m[1]).replace(/\s+/g, ' ').trim();
            if (text) snippets.push({ pos: m.index, text });
        }

        // Assign the next excerpt to each title that follows it, but before the
        // next title – this way the assignment remains correct even if
        // a hit has no excerpt.
        const out: SearchResult[] = [];
        for (let i = 0; i < titles.length && out.length < maxResults; i++) {
            const start = titles[i].pos;
            const end = i + 1 < titles.length ? titles[i + 1].pos : Infinity;
            const snip = snippets.find(s => s.pos > start && s.pos < end);
            out.push({
                title: titles[i].title,
                url: titles[i].url,
                snippet: snip ? snip.text : ''
            });
        }
        return out;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Retrieve page and make it readable
    // ──────────────────────────────────────────────────────────────────────

    /**
     * Fetch a page and return it as text.
     *
     * This is the actual workhorse: a search result list consists of
     * Titles and links that a model cannot make sense of. Only the
     * The page content answers the question. Therefore, Claude Code, in addition to the
     * Find a tool that fetches a URL – here the same one.
     *
     * @param url        http/https-Adresse
     * @param maxChars   Upper limit for the returned text
     */
    async fetchPage(url: string, maxChars = 20_000): Promise<{ url: string; title: string; text: string }> {
        if (!/^https?:\/\//i.test(url)) {
            throw new Error(`Nur http/https-Adressen erlaubt: ${url}`);
        }

        this.logger.info(`Seite abrufen: ${url}`);
        const raw = await this.httpGet(url);

        const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? this.stripHtml(titleMatch[1]).trim() : '';

        const text = this.htmlToText(raw);
        const clipped = text.length > maxChars
            ? text.slice(0, maxChars) + `\n… [gekürzt, ${text.length - maxChars} Zeichen mehr]`
            : text;

        this.logger.info(`Seite abgerufen: ${url} (${text.length} Zeichen Text)`);
        return { url, title, text: clipped };
    }

    /**
     * HTML in lesbaren Text wandeln.
     *
     * Scripts, styles, navigation, and comments are removed; block elements
     * will result in line breaks. The output should be readable, not
     * look nice.
     */
    private htmlToText(html: string): string {
        return html
            // Completely remove non-content
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, '')
            .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, '')
            // Identify headings and list items
            .replace(/<h[1-6][^>]*>/gi, '\n\n## ')
            .replace(/<li[^>]*>/gi, '\n- ')
            // Block elements to line breaks
            .replace(/<\/(p|div|section|article|tr|h[1-6]|li|ul|ol|table|pre|blockquote)>/gi, '\n')
            .replace(/<br\s*\/?>/gi, '\n')
            // Restliche Tags weg
            .replace(/<[^>]+>/g, ' ')
            // Entities
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;|&apos;/g, "'")
            .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
            // Clean up whitespace and remove empty scaffold lines.
            // Navigation lists otherwise leave dozens of bare "-" at
            // the beginning of each page before the actual content starts.
            .split('\n')
            .map(l => l.replace(/[ \t]+/g, ' ').trim())
            .filter(l => l !== '-' && l !== '##' && l !== '#')
            .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
            .join('\n')
            .trim();
    }

    // ──────────────────────────────────────────────────────────────────────
    // Hilfsmethoden
    // ──────────────────────────────────────────────────────────────────────

    /** Formatiert Suchergebnisse als lesbaren KI-Kontext */
    formatForAI(response: SearchResponse): string {
        if (response.results.length === 0 && !response.abstract && !response.answer) {
            // Answer with guiding actions. "No results" alone causes the
            // model to repeat the same search; it must know that the search
            // itself is unavailable and which alternative path remains.
            const why = response.problems?.length
                ? `\nReason: ${response.problems.join('; ')}`
                : '';
            return `The web search for "${response.query}" returned no results.${why}\n\n`
                + `Search is unavailable right now (keyless search services throttle hard). `
                + `Do NOT repeat it. Instead:\n`
                + `- If you know a suitable address, fetch it directly with action:web_fetch `
                + `(e.g. the project's official documentation).\n`
                + `- Otherwise continue with the code you can read in the workspace.\n`
                + `- For reliable search the user can configure a provider with an API key `
                + `under "Web-Suche" in the settings (Tavily, Brave or Google).`;
        }

        const lines: string[] = [`## Web search: "${response.query}"\n`];

        if (response.answer) {
            lines.push(`**Direct answer:** ${response.answer}\n`);
        }
        if (response.abstract) {
            lines.push(`**Summary:** ${response.abstract}\n`);
        }
        if (response.results.length > 0) {
            lines.push('**Results:**\n');
            response.results.forEach((r, i) => {
                lines.push(`${i + 1}. **${r.title}**`);
                lines.push(`   URL: ${r.url}`);
                if (r.snippet) lines.push(`   ${r.snippet}`);
                lines.push('');
            });
        }

        return lines.join('\n');
    }

    private stripHtml(html: string): string {
        return html
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ')
            .trim();
    }

    private extractTitle(url: string): string {
        try {
            const u = new URL(url);
            return u.hostname.replace(/^www\./, '') + u.pathname;
        } catch {
            return url;
        }
    }

    private decodeRedirectUrl(url: string): string {
        // DDG redirect: //duckduckgo.com/l/?uddg=https%3A...
        const match = url.match(/uddg=([^&]+)/);
        if (match) {
            try { return decodeURIComponent(match[1]); } catch { /* ignore */ }
        }
        if (url.startsWith('//')) return 'https:' + url;
        return url;
    }

    /**
     * Fetch the page or JSON.
     *
     * Follows redirects: almost every documentation page responds with 301
     * or 302 (http→https, with/without www, language switch). Without this, only a
     * empty body returned and `web_fetch` would be useless.
     */
    private httpGet(
        url: string,
        redirectsLeft = 5,
        extraHeaders: Record<string, string> = {}
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const lib = url.startsWith('https') ? https : http;
            const req = lib.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; AI-Code-Assistant/1.0)',
                    'Accept': 'text/html,application/json,application/xhtml+xml',
                    'Accept-Language': 'de,en;q=0.8',
                    ...extraHeaders
                },
                timeout: 15_000
            }, (res) => {
                const status = res.statusCode ?? 0;
                const location = res.headers.location;

                if (status >= 300 && status < 400 && location) {
                    res.resume();   // Rumpf verwerfen, sonst bleibt der Socket offen
                    if (redirectsLeft <= 0) {
                        reject(new Error(`Zu viele Weiterleitungen (${url})`));
                        return;
                    }
                    // Refer to the relative location to the base address
                    const next = new URL(location, url).toString();
                    this.logger.info(`Weiterleitung ${status}: ${url} → ${next}`);
                    this.httpGet(next, redirectsLeft - 1, extraHeaders).then(resolve, reject);
                    return;
                }

                if (status >= 400) {
                    res.resume();
                    reject(new Error(`HTTP ${status} für ${url}`));
                    return;
                }

                let data = '';
                res.setEncoding('utf-8');
                res.on('data', (d: string) => { data += d; });
                res.on('end', () => resolve(data));
                res.on('error', reject);
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy(new Error(`Timeout nach 15s für ${url}`));
            });
        });
    }

    /** Send JSON via POST – for search APIs that expect a body. */
    private httpPostJson(url: string, payload: Record<string, unknown>): Promise<string> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const lib = parsed.protocol === 'https:' ? https : http;
            const data = JSON.stringify(payload);

            const req = lib.request({
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    'Accept': 'application/json'
                },
                timeout: 20_000
            }, (res) => {
                let out = '';
                res.setEncoding('utf-8');
                res.on('data', (d: string) => { out += d; });
                res.on('end', () => {
                    if ((res.statusCode ?? 0) >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}: ${out.slice(0, 200)}`));
                    } else {
                        resolve(out);
                    }
                });
                res.on('error', reject);
            });

            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('Timeout nach 20s')));
            req.write(data);
            req.end();
        });
    }

    private httpPost(url: string, body: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const options: http.RequestOptions = {
                hostname: parsed.hostname,
                port: 443,
                path: parsed.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
                    'Accept': 'text/html',
                    'Accept-Language': 'de-DE,de;q=0.9',
                    'Referer': 'https://duckduckgo.com/'
                },
                timeout: 15_000
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (d: Buffer) => { data += d.toString(); });
                res.on('end', () => resolve(data));
                res.on('error', reject);
            });
            req.on('error', reject);
            req.on('timeout', () => reject(new Error('Timeout nach 15s')));
            req.write(body);
            req.end();
        });
    }
}
