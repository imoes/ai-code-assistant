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

    async search(query: string, maxResults = 5): Promise<SearchResponse> {
        this.logger.info(`Web-Suche: "${query}"`);

        // Primär: Instant Answer API
        try {
            const instantResult = await this.searchInstantAnswer(query, maxResults);
            if (instantResult.results.length > 0 || instantResult.abstract || instantResult.answer) {
                this.logger.info(`Web-Suche (Instant Answer): ${instantResult.results.length} Ergebnis(se)`);
                return instantResult;
            }
        } catch (err) {
            this.logger.warn(`Instant Answer fehlgeschlagen: ${(err as Error).message}`);
        }

        // Fallback: HTML scraping
        try {
            const htmlResult = await this.searchHtml(query, maxResults);
            this.logger.info(`Web-Suche (HTML): ${htmlResult.results.length} Ergebnis(se)`);
            return htmlResult;
        } catch (err) {
            this.logger.warn(`HTML-Suche fehlgeschlagen: ${(err as Error).message}`);
        }

        return { query, results: [] };
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

        const results: SearchResult[] = [];

        // result__title + result__url + result__snippet
        const blockPattern = /<div class="result[^"]*"[\s\S]*?(?=<div class="result[^"]*"|<div id="links_wrapper|$)/g;
        let block: RegExpExecArray | null;

        while ((block = blockPattern.exec(raw)) !== null && results.length < maxResults) {
            const html = block[0];

            const titleMatch  = html.match(/class="result__title"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
            const snippetMatch = html.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

            if (!titleMatch) continue;

            const url     = this.decodeRedirectUrl(titleMatch[1]);
            const title   = this.stripHtml(titleMatch[2]).trim();
            const snippet = snippetMatch ? this.stripHtml(snippetMatch[1]).trim() : '';

            if (url && title) {
                results.push({ title, url, snippet });
            }
        }

        return { query, results };
    }

    // ──────────────────────────────────────────────────────────────────────
    // Hilfsmethoden
    // ──────────────────────────────────────────────────────────────────────

    /** Formatiert Suchergebnisse als lesbaren KI-Kontext */
    formatForAI(response: SearchResponse): string {
        if (response.results.length === 0 && !response.abstract && !response.answer) {
            return `Web-Suche für "${response.query}": Keine Ergebnisse gefunden.`;
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

    private httpGet(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const lib = url.startsWith('https') ? https : http;
            const req = lib.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; AI-Code-Assistant/1.0)',
                    'Accept': 'application/json, text/html'
                },
                timeout: 10_000
            }, (res) => {
                let data = '';
                res.on('data', (d: Buffer) => { data += d.toString(); });
                res.on('end', () => resolve(data));
                res.on('error', reject);
            });
            req.on('error', reject);
            req.on('timeout', () => reject(new Error('Timeout nach 10s')));
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
