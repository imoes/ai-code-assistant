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
    /** Warum kein Anbieter Treffer lieferte – für eine verwertbare Meldung */
    problems?: string[];
}

/**
 * WebSearcher: DuckDuckGo Instant Answer API + HTML-Fallback.
 *
 * Primär: https://api.duckduckgo.com/?q=<query>&format=json
 *   → Liefert Abstract, Answer, RelatedTopics
 * Fallback: https://html.duckduckgo.com/html/ POST
 *   → Parsed result__title / result__snippet aus HTML
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
     * Suche über eine Kette von Anbietern.
     *
     * Warum eine Kette und nicht ein Anbieter: schlüsselfreie Suche ist nicht
     * verlässlich. Die DuckDuckGo-Instant-Answer-API antwortet unter Last mit
     * HTTP 202 und leeren Feldern, der HTML-Endpunkt liefert nach einigen
     * Anfragen nichts mehr, und öffentliche SearXNG-Instanzen antworten mit
     * 403 oder 429. Deshalb: ein konfigurierter Anbieter mit Schlüssel zuerst
     * (verlässlich), die schlüsselfreien Wege danach (besser als nichts).
     *
     * Führt kein Weg zu Treffern, sagt das Ergebnis deutlich, dass der Assistent
     * stattdessen `web_fetch` mit einer konkreten Adresse nutzen soll – eine
     * leere Trefferliste ohne Hinweis lässt das Modell nur raten.
     */
    async search(query: string, maxResults = 5): Promise<SearchResponse> {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        const provider = config.get<string>('searchProvider', 'auto');
        const apiKey = config.get<string>('searchApiKey', '').trim();
        const endpoint = config.get<string>('searchEndpoint', '').trim();

        this.logger.info(`Web-Suche: "${query}" (Anbieter: ${provider})`);

        // Reihenfolge festlegen: ausdrücklich gewählter Anbieter allein,
        // sonst alles Verfügbare der Verlässlichkeit nach.
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
                // Die Begründungen der Unterquellen durchreichen. Sonst steht
                // außen nur „keyless: keine Treffer", und weder Benutzer noch
                // Modell erfahren, ob gesperrt, gedrosselt oder wirklich leer.
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

    /** Einen einzelnen Anbieter befragen. */
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
                // Erst die Instant-Answer-API (liefert manchmal eine direkte
                // Antwort), dann die HTML-Seite.
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
     * Tavily – auf KI-Nutzung ausgelegt: liefert Textauszüge statt nur Links.
     * Kostenloses Kontingent, Schlüssel erforderlich.
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

    /** Brave Search API – Schlüssel erforderlich, kostenloses Kontingent. */
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

    /** Google Programmable Search – Schlüssel und Such-ID (cx) erforderlich. */
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
    // Schlüsselfreie Suche: mehrere unabhängige Quellen gleichzeitig
    // ──────────────────────────────────────────────────────────────────────

    /**
     * Suche ohne Schlüssel – über mehrere Quellen parallel.
     *
     * Es gibt keine kostenlose, unbegrenzte, allgemeine Websuche. Jeder Weg ist
     * entweder ein Anbieter mit Kontingent, oder er kratzt eine HTML-Seite ab
     * und wird ab einem gewissen Volumen gesperrt. Ein eigener SearXNG hilft
     * dabei nicht: er verlagert das Abkratzen nur, die Sperren der befragten
     * Suchmaschinen gelten weiter. Und die Bing-Such-API ist seit dem
     * 11. August 2025 abgeschaltet.
     *
     * Was hilft, ist Unabhängigkeit der Quellen. Gefragt werden gleichzeitig:
     *
     * - DuckDuckGo HTML und DuckDuckGo Lite – zwei getrennte Oberflächen
     * - Stack Exchange – offizielle API, ohne Schlüssel 300 Anfragen/Tag pro IP
     * - Wikipedia (MediaWiki) – offizielle API, ohne Schlüssel, hohe Grenzen
     *
     * Fällt eine Quelle aus, tragen die anderen. Die Treffer werden über die
     * Adresse zusammengeführt, damit dieselbe Seite nicht doppelt erscheint.
     * Für eine bekannte Adresse bleibt `web_fetch` der verlässliche Weg – der
     * hat gar kein Kontingent.
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

        // DuckDuckGo zählt als EINE Quelle: erst /html/, nur bei Fehlschlag die
        // Lite-Seite. Beide gleichzeitig zu fragen verdoppelt die Last auf
        // demselben Dienst und führt schneller zur Sperre – im Probelauf war
        // DuckDuckGo nach der fünften Anfrage in Folge stumm.
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

        // Wikipedia erst, wenn sonst nichts kam. Für „typescript satisfies
        // operator" lieferte sie im Probelauf den Artikel „Modulo" – als
        // Ergänzung ist das Rauschen, als letzter Ausweg besser als nichts.
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
     * DuckDuckGo Lite – dieselbe Suche, andere Oberfläche.
     *
     * Eine zweite, unabhängige Adresse mit eigener Auszeichnung: sperrt oder
     * leert die eine Oberfläche, liefert die andere oft noch. Die Lite-Seite
     * ist eine Tabelle mit `result-link` und `result-snippet`, jeweils in
     * einfachen Anführungszeichen – nicht dieselbe Auszeichnung wie /html/.
     */
    private async searchDuckDuckGoLite(query: string, maxResults: number): Promise<SearchResponse> {
        const raw = await this.httpPost(
            'https://lite.duckduckgo.com/lite/',
            `q=${encodeURIComponent(query)}&kl=wt-wt`
        );
        return { query, results: this.parseDuckDuckGoLiteHtml(raw, maxResults) };
    }

    /** Treffer aus der Lite-Seite lesen – getrennt vom Netzaufruf, damit prüfbar. */
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

        // Auf der Lite-Seite steht der Auszug VOR dem nächsten Titel, aber nach
        // dem eigenen – gepaart wird über die Position, wie bei /html/.
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
     * Stack Exchange – offizielle API, ohne Schlüssel nutzbar.
     *
     * Ohne Schlüssel gelten 300 Anfragen pro Tag und IP; das ist für einen
     * Assistenten mit einer Handvoll Suchen pro Aufgabe reichlich. Und es ist
     * eine echte API: keine HTML-Auszeichnung, die sich morgen ändert.
     *
     * Für Programmierfragen ist das oft die bessere Quelle als eine allgemeine
     * Suchmaschine – Titel und Punktestand sagen mehr als ein Textauszug.
     */
    private async searchStackExchange(query: string, maxResults: number): Promise<SearchResponse> {
        const url = 'https://api.stackexchange.com/2.3/search/advanced'
            + `?order=desc&sort=relevance&site=stackoverflow&pagesize=${Math.max(1, maxResults)}`
            + `&q=${encodeURIComponent(query)}`;
        const raw = await this.httpGet(url, 5, { 'Accept': 'application/json' });
        return { query, results: this.mapStackExchange(JSON.parse(raw), maxResults) };
    }

    /** Antwort der Stack-Exchange-API in Treffer übersetzen. */
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
            // Der Textauszug wird gebaut: die API liefert ohne Filter keinen
            // Fragetext, aber Punktestand und Antwortzahl sagen genug darüber,
            // ob sich das Öffnen lohnt.
            snippet: `Stack Overflow · ${it.score ?? 0} Punkte · `
                + `${it.answer_count ?? 0} Antwort(en)`
                + `${it.is_answered ? ', akzeptiert' : ''}`
                + `${it.tags?.length ? ' · ' + it.tags.slice(0, 5).join(', ') : ''}`
        })).filter((r: SearchResult) => r.url);
    }

    /**
     * Wikipedia über die MediaWiki-API – schlüssellos und offiziell.
     *
     * Für Begriffe und Verfahren („Was ist ein Recursive-Descent-Parser") die
     * verlässlichste schlüsselfreie Quelle überhaupt. Für Programmierdetails
     * taugt sie nicht, deshalb steht sie in der Zusammenführung hinten.
     */
    /**
     * Wikipedia-Sprachausgabe zur Suchanfrage wählen.
     *
     * Umlaute und deutsche Funktionswörter entscheiden. Ein Großbuchstabe taugt
     * nicht als Merkmal: „Typescript satisfies operator" landete damit auf
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

        // Frageformeln entfernen: „wie funktioniert ein recursive descent
        // parser" findet in der Volltextsuche nichts, „recursive descent
        // parser" schon.
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
     * SearXNG – nur mit eigener Instanz brauchbar: öffentliche Instanzen
     * antworten mit 403 oder 429.
     *
     * Wichtig: eine frische Instanz gibt kein JSON heraus. In `settings.yml`
     * muss `search.formats` auch `json` enthalten, sonst antwortet sie mit 403.
     * Und Unbegrenztheit bringt die eigene Instanz nicht: SearXNG befragt
     * Google, Bing und DuckDuckGo für dich – deren Sperren gelten weiter.
     */
    private async searchSearxng(
        query: string, maxResults: number, base: string
    ): Promise<SearchResponse> {
        const root = base.replace(/\/+$/, '');
        const url = `${root}/search?q=${encodeURIComponent(query)}&format=json`;
        const raw = await this.httpGet(url, 5, { 'Accept': 'application/json' });

        // Eine frische Instanz gibt kein JSON heraus und antwortet mit der
        // HTML-Seite. Die Meldung muss sagen, was zu tun ist – sonst sucht man
        // den Fehler im Client statt in settings.yml.
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
     * Treffer aus der HTML-Antwort lesen.
     *
     * Nicht über Blöcke: die Seite verschachtelt mehrere Elemente, deren
     * Klassennamen alle mit "result" beginnen (`result__extras`, `result__body`).
     * Ein Blockmuster zerschneidet damit jeden Treffer in Stücke, und die
     * Textauszüge landeten im falschen Teil – die KI bekam nur Titel und Links,
     * mit denen sie nichts anfangen kann.
     *
     * Stattdessen: Titel-Links und Auszüge einzeln in Dokumentreihenfolge
     * einsammeln und über ihre Position paaren.
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

        // Jedem Titel den nächsten Auszug NACH ihm zuordnen, aber vor dem
        // nächsten Titel – so bleibt die Zuordnung auch dann richtig, wenn
        // ein Treffer keinen Auszug hat.
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
    // Seite abrufen und lesbar machen
    // ──────────────────────────────────────────────────────────────────────

    /**
     * Eine Seite abrufen und als Text zurückgeben.
     *
     * Das ist das eigentliche Arbeitspferd: eine Suchtrefferliste besteht aus
     * Titeln und Links, mit denen ein Modell nichts anfangen kann. Erst der
     * Seiteninhalt beantwortet die Frage. Deshalb hat Claude Code neben der
     * Suche ein Werkzeug, das eine URL holt – hier dasselbe.
     *
     * @param url        http/https-Adresse
     * @param maxChars   Obergrenze für den zurückgegebenen Text
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
     * Skripte, Stile, Navigation und Kommentare fliegen raus; Blockelemente
     * werden zu Zeilenumbrüchen. Das Ergebnis soll gelesen werden können, nicht
     * schön aussehen.
     */
    private htmlToText(html: string): string {
        return html
            // Nicht-Inhalt komplett entfernen
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, '')
            .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, '')
            // Überschriften und Listenpunkte kenntlich machen
            .replace(/<h[1-6][^>]*>/gi, '\n\n## ')
            .replace(/<li[^>]*>/gi, '\n- ')
            // Blockelemente zu Zeilenumbrüchen
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
            // Leerraum aufräumen und leere Gerüstzeilen entfernen.
            // Navigationslisten hinterlassen sonst dutzende nackte "-" am
            // Anfang jeder Seite, bevor der eigentliche Inhalt beginnt.
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
            // Handlungsleitend antworten. "Keine Ergebnisse" allein lässt das
            // Modell dieselbe Suche wiederholen; es muss wissen, dass die Suche
            // selbst nicht verfügbar ist und welcher Weg stattdessen bleibt.
            const why = response.problems?.length
                ? `\nGrund: ${response.problems.join('; ')}`
                : '';
            return `Web-Suche für "${response.query}" lieferte keine Ergebnisse.${why}\n\n`
                + `Die Suche ist gerade nicht verfügbar (schlüsselfreie Suchdienste drosseln stark). `
                + `Wiederhole sie NICHT. Stattdessen:\n`
                + `- Kennst du eine passende Adresse, rufe sie direkt mit action:web_fetch ab `
                + `(z.B. die offizielle Dokumentation des Projekts).\n`
                + `- Sonst arbeite mit dem Code weiter, den du im Workspace lesen kannst.\n`
                + `- Für verlässliche Suche kann der Benutzer in den Einstellungen unter `
                + `"Web-Suche" einen Anbieter mit API-Key eintragen (Tavily, Brave oder Google).`;
        }

        const lines: string[] = [`## Web-Suche: "${response.query}"\n`];

        if (response.answer) {
            lines.push(`**Direkte Antwort:** ${response.answer}\n`);
        }
        if (response.abstract) {
            lines.push(`**Zusammenfassung:** ${response.abstract}\n`);
        }
        if (response.results.length > 0) {
            lines.push('**Suchergebnisse:**\n');
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
     * Seite oder JSON abrufen.
     *
     * Folgt Weiterleitungen: fast jede Dokumentationsseite antwortet mit 301
     * oder 302 (http→https, mit/ohne www, Sprachweiche). Ohne das kam nur ein
     * leerer Rumpf zurück und `web_fetch` wäre nutzlos.
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
                    // Relative Location auf die Ausgangsadresse beziehen
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

    /** JSON per POST senden – für Such-APIs, die einen Rumpf erwarten. */
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
