import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { Logger } from './logger';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface CompletionOptions {
    maxTokens?: number;
    temperature?: number;
    stream?: boolean;
    stopSequences?: string[];
    /** Werkzeuge im OpenAI-Schema. Der Server erzeugt und parst das
     *  modellspezifische Format dann selbst (llama.cpp mit --jinja). */
    tools?: ToolSchema[];
    /** Callback für laufende Kennzahlen während des Streamings */
    onStats?: StatsCallback;
}

/** Werkzeugdefinition im OpenAI-Schema. */
export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

/** Ein vom Server geparster Werkzeugaufruf. */
export interface ToolCallResult {
    id?: string;
    name: string;
    /** Argumente als JSON-String, so wie die OpenAI-API sie liefert */
    arguments: string;
}

export interface CompletionResult {
    content: string;
    tokenCount?: number;
    finishReason?: string;
    /** Vom Server geparste Werkzeugaufrufe (leer/undefined wenn keine) */
    toolCalls?: ToolCallResult[];
}

// Callback-Typ für Streaming-Tokens
export type StreamCallback = (token: string, done: boolean) => void;

/**
 * Laufende Kennzahlen der Generierung, so wie llama.cpp sie meldet.
 *
 * Der Server schickt sie bei `timings_per_token` bzw. `return_progress`
 * mit jedem Chunk – damit lässt sich anzeigen, wie weit die Prompt-Auswertung
 * ist und wie schnell das Modell arbeitet.
 */
export interface GenerationStats {
    /** Ausgewertete Prompt-Tokens (Eingabe) */
    promptTokens: number;
    /** Prompt-Tokens pro Sekunde */
    promptPerSecond: number;
    /** Aus dem Cache übernommene Prompt-Tokens (mussten nicht gerechnet werden) */
    cachedTokens: number;
    /** Erzeugte Tokens (Ausgabe) */
    predictedTokens: number;
    /** Erzeugte Tokens pro Sekunde */
    predictedPerSecond: number;
    /** Fortschritt der Prompt-Auswertung, falls der Server ihn meldet */
    promptProgress?: {
        processed: number;
        total: number;
        /** Anteil 0..1 */
        fraction: number;
    };
}

/** Callback für laufende Kennzahlen (Fortschritt, Tokens, Tokens/Sekunde). */
export type StatsCallback = (stats: GenerationStats) => void;

/**
 * MCPClient: Kommuniziert mit dem llama.cpp Server.
 *
 * Unterstützt zwei Modi:
 *  1. OpenAI-kompatible REST API  (/v1/chat/completions)  — Standard
 *  2. llama.cpp natives MCP-Protokoll  (/mcp)            — optional
 *
 * Der Endpunkt ist vollständig konfigurierbar über
 * aiAssistant.serverUrl (Standard: http://localhost:8080).
 */
export class MCPClient {
    private static instance: MCPClient;
    private logger = Logger.getInstance();
    private currentReq: http.ClientRequest | null = null;
    private abortFlag = false;

    private constructor() {}

    /** Laufende Anfrage abbrechen. */
    cancel(): void {
        this.abortFlag = true;
        if (this.currentReq) {
            this.currentReq.destroy(new Error('Vom Benutzer abgebrochen'));
            this.currentReq = null;
        }
    }

    static getInstance(): MCPClient {
        if (!MCPClient.instance) {
            MCPClient.instance = new MCPClient();
        }
        return MCPClient.instance;
    }

    /** Aktuelle Server-URL aus VSCode-Einstellungen */
    private getServerUrl(): string {
        return vscode.workspace
            .getConfiguration('aiAssistant')
            .get<string>('serverUrl', 'http://localhost:8080')
            .replace(/\/$/, ''); // Trailing-Slash entfernen
    }

    private getMaxTokens(): number {
        return vscode.workspace
            .getConfiguration('aiAssistant')
            .get<number>('maxTokens', 2048);
    }

    private getTemperature(): number {
        return vscode.workspace
            .getConfiguration('aiAssistant')
            .get<number>('temperature', 0.2);
    }

    private isMCPEnabled(): boolean {
        return vscode.workspace
            .getConfiguration('aiAssistant')
            .get<boolean>('mcpEnabled', true);
    }

    private getModel(): string {
        return vscode.workspace
            .getConfiguration('aiAssistant')
            .get<string>('model', '');
    }

    /**
     * Optionaler API-Key (z.B. OpenRouter, Together, Groq, OpenAI).
     * Leer lassen für lokale llama.cpp-Server – die brauchen keinen Key.
     */
    private getApiKey(): string {
        return vscode.workspace
            .getConfiguration('aiAssistant')
            .get<string>('apiKey', '')
            .trim();
    }

    /**
     * Auth-/Provider-Header für die aktuelle Konfiguration.
     * OpenRouter verlangt zusätzlich HTTP-Referer und X-Title.
     */
    private buildAuthHeaders(): Record<string, string> {
        const headers: Record<string, string> = {};
        const key = this.getApiKey();
        if (!key) return headers;

        headers['Authorization'] = `Bearer ${key}`;

        if (this.getServerUrl().includes('openrouter.ai')) {
            headers['HTTP-Referer'] = 'https://github.com/ai-code-assistant';
            headers['X-Title'] = 'AI Code Assistant (VS Code)';
        }
        return headers;
    }

    /** Zwischengespeicherte Kontextgröße pro Server-URL */
    private ctxCache = new Map<string, number>();

    /**
     * Kontextgröße des Modells in Tokens.
     *
     * llama.cpp meldet sie unter /v1/models als `meta.n_ctx` – das ist die
     * echte Grenze, nicht geschätzt. Antwortet der Server nicht oder kennt das
     * Feld nicht (Cloud-Anbieter), gibt die Methode undefined zurück; der
     * Aufrufer nutzt dann den konfigurierten Schwellenwert.
     */
    async getContextSize(): Promise<number | undefined> {
        const baseUrl = this.getServerUrl();
        const cached = this.ctxCache.get(baseUrl);
        if (cached) return cached;

        try {
            const raw = await this.httpGet(`${baseUrl}/v1/models`);
            const parsed = JSON.parse(raw);
            const wanted = this.getModel();

            const entries: { id?: string; meta?: { n_ctx?: number } }[] = parsed.data ?? [];
            const hit = (wanted ? entries.find(e => e.id === wanted) : undefined) ?? entries[0];
            const n = hit?.meta?.n_ctx;

            if (typeof n === 'number' && n > 0) {
                this.ctxCache.set(baseUrl, n);
                this.logger.info(`Kontextgröße des Modells: ${n} Tokens`);
                return n;
            }
        } catch (err) {
            this.logger.warn(`Kontextgröße nicht abfragbar: ${(err as Error).message}`);
        }
        return undefined;
    }

    /**
     * Zeigt die URL auf einen Cloud-Anbieter statt auf einen lokalen Server?
     * Erkennungsmerkmal: kein localhost/127.0.0.1 und ein API-Key ist gesetzt.
     */
    private isCloudEndpoint(): boolean {
        const url = this.getServerUrl();
        const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(url);
        return !isLocal && !!this.getApiKey();
    }

    /**
     * Verbindung zum llama.cpp Server testen.
     * Gibt Model-Infos zurück oder wirft einen Fehler.
     */
    async testConnection(): Promise<{ success: boolean; info: string }> {
        const baseUrl = this.getServerUrl();
        const auth = this.getApiKey() ? ' (mit API-Key)' : '';

        // ── /v1/models: funktioniert bei llama.cpp UND bei Cloud-Providern ────
        // Bei OpenRouter liefert das >300 Modelle – deshalb nur die ersten paar.
        let modelInfo = '';
        let modelsOk = false;
        try {
            const models = await this.httpGet(`${baseUrl}/v1/models`);
            const modelsObj = JSON.parse(models);
            const ids: string[] = (modelsObj.data ?? []).map((m: { id: string }) => m.id);
            if (ids.length > 0) {
                modelsOk = true;
                const shown = ids.slice(0, 5).join(', ');
                const more = ids.length > 5 ? ` … (+${ids.length - 5})` : '';
                modelInfo = ` | ${ids.length} Modell(e): ${shown}${more}`;
            }
        } catch (err) {
            modelInfo = ` | /v1/models: ${(err as Error).message.slice(0, 120)}`;
        }

        // ── /health: nur llama.cpp, bei Cloud-Providern erwartet fehlend ──────
        try {
            const health = await this.httpGet(`${baseUrl}/health`);
            const healthObj = JSON.parse(health);
            return { success: true, info: `Status: ${healthObj.status ?? 'ok'}${auth}${modelInfo}` };
        } catch (err) {
            if (modelsOk) {
                // Kein /health-Endpunkt (normal bei OpenRouter/OpenAI) – trotzdem erreichbar
                return { success: true, info: `Erreichbar${auth}${modelInfo}` };
            }
            return { success: false, info: `${(err as Error).message}${modelInfo}` };
        }
    }

    /**
     * Hauptmethode: Chat-Completion anfragen.
     * Wählt automatisch MCP oder OpenAI-API je nach Konfiguration.
     *
     * @param messages  Nachrichtenverlauf (system + user + assistant)
     * @param options   Optionale Override-Parameter
     * @param onStream  Callback für Token-Streaming (optional)
     */
    async complete(
        messages: ChatMessage[],
        options: CompletionOptions = {},
        onStream?: StreamCallback
    ): Promise<CompletionResult> {
        // Cloud-Provider (OpenRouter & Co.) sprechen kein llama.cpp-MCP.
        // Der /mcp-Versuch würde nur eine 404-Runde kosten → direkt OpenAI-API.
        if (this.isMCPEnabled() && !this.isCloudEndpoint()) {
            return this.completeMCP(messages, options, onStream);
        }
        return this.completeOpenAI(messages, options, onStream);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // OpenAI-kompatibler Endpunkt (/v1/chat/completions)
    // ──────────────────────────────────────────────────────────────────────────

    private async completeOpenAI(
        messages: ChatMessage[],
        options: CompletionOptions,
        onStream?: StreamCallback
    ): Promise<CompletionResult> {
        const baseUrl = this.getServerUrl();
        const url = `${baseUrl}/v1/chat/completions`;
        const stream = !!onStream;

        const body: Record<string, unknown> = {
            messages,
            max_tokens: options.maxTokens ?? this.getMaxTokens(),
            temperature: options.temperature ?? this.getTemperature(),
            stream
        };

        const model = options ? this.getModel() : '';
        if (model) body.model = model;
        if (options.stopSequences?.length) body.stop = options.stopSequences;

        // Werkzeuge im OpenAI-Schema mitsenden. llama.cpp (mit --jinja) rendert
        // sie ins Format des jeweiligen Modells und parst die Antwort zurück –
        // dadurch funktioniert dieselbe Anfrage mit Qwen, Gemma, Kimi, laguna,
        // DeepSeek und allem, was der Server künftig unterstützt.
        if (options.tools?.length) {
            body.tools = options.tools.map(t => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters }
            }));
            body.tool_choice = 'auto';
        }

        // Kennzahlen mitschicken lassen: Fortschritt der Prompt-Auswertung und
        // Tokens/Sekunde. Nur llama.cpp kennt diese Felder; andere Server
        // ignorieren unbekannte Body-Felder.
        if (stream && options.onStats) {
            body.timings_per_token = true;
            body.return_progress = true;
        }

        this.logger.info(
            `→ OpenAI API: ${url}  (stream=${stream}` +
            `${options.tools?.length ? `, tools=${options.tools.length}` : ''})`
        );

        if (stream && onStream) {
            return this.streamOpenAI(url, body, onStream, options.onStats);
        }

        const responseText = await this.httpPost(url, body);
        const parsed = JSON.parse(responseText);

        const message = parsed.choices?.[0]?.message ?? {};
        const content: string = message.content ?? '';
        const tokenCount: number =
            parsed.usage?.completion_tokens;
        const finishReason: string =
            parsed.choices?.[0]?.finish_reason ?? 'unknown';

        // Reasoning-Modelle liefern den Denkteil separat – als <think> anhängen,
        // damit die Anzeige ihn wie beim Streaming einklappen kann.
        const reasoning: string = message.reasoning_content ?? '';
        const fullContent = reasoning ? `<think>${reasoning}</think>${content}` : content;

        return {
            content: fullContent,
            tokenCount,
            finishReason,
            toolCalls: this.extractToolCalls(message.tool_calls)
        };
    }

    /**
     * Kennzahlen aus einem llama.cpp-Chunk lesen.
     *
     * `timings` sind kumulativ, `prompt_progress` beschreibt den aktuellen Stand
     * der Prompt-Auswertung. Fehlt eines von beiden, bleibt der Rest gültig.
     */
    private readStats(evt: Record<string, unknown>): GenerationStats {
        const t = (evt.timings ?? {}) as Record<string, number>;
        const p = evt.prompt_progress as
            { total?: number; processed?: number; cache?: number } | undefined;

        const stats: GenerationStats = {
            promptTokens: t.prompt_n ?? 0,
            promptPerSecond: t.prompt_per_second ?? 0,
            cachedTokens: t.cache_n ?? 0,
            predictedTokens: t.predicted_n ?? 0,
            predictedPerSecond: t.predicted_per_second ?? 0
        };

        if (p && typeof p.total === 'number' && p.total > 0) {
            const processed = (p.processed ?? 0) + (p.cache ?? 0);
            stats.promptProgress = {
                processed,
                total: p.total,
                fraction: Math.min(1, processed / p.total)
            };
        }

        return stats;
    }

    /** tool_calls aus einer OpenAI-Antwort in unsere Form bringen. */
    private extractToolCalls(raw: unknown): ToolCallResult[] | undefined {
        if (!Array.isArray(raw) || raw.length === 0) return undefined;

        const calls: ToolCallResult[] = [];
        for (const entry of raw) {
            const fn = (entry as { function?: { name?: string; arguments?: string } }).function;
            const name = fn?.name ?? (entry as { name?: string }).name;
            if (!name) continue;
            calls.push({
                id: (entry as { id?: string }).id,
                name,
                arguments: fn?.arguments ?? (entry as { arguments?: string }).arguments ?? '{}'
            });
        }
        return calls.length > 0 ? calls : undefined;
    }

    /** Server-Sent-Events Streaming für /v1/chat/completions */
    private streamOpenAI(
        url: string,
        body: Record<string, unknown>,
        onStream: StreamCallback,
        onStats?: StatsCallback
    ): Promise<CompletionResult> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const isHttps = parsed.protocol === 'https:';
            const lib = isHttps ? https : http;

            const postData = JSON.stringify(body);
            const options: http.RequestOptions = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'Accept': 'text/event-stream',
                    ...this.buildAuthHeaders()
                }
            };

            this.abortFlag = false;
            let fullContent = '';

            // Untätigkeits-Timeout.
            //
            // Die Streaming-Anfrage hatte bisher gar keinen: blieb der Server
            // mitten im Stream stehen, wartete der Assistent unbegrenzt – ohne
            // Meldung und ohne Ausweg außer "Abbrechen". Beobachtet bei einem
            // ausgelasteten llama.cpp-Server: 50 Minuten Stille.
            //
            // Gemessen wird die Pause ZWISCHEN zwei Chunks, nicht die
            // Gesamtdauer: eine lange Antwort ist in Ordnung, Stillstand nicht.
            const idleMs = Math.max(30, vscode.workspace
                .getConfiguration('aiAssistant')
                .get<number>('streamIdleTimeoutSeconds', 180)) * 1000;

            let idleTimer: NodeJS.Timeout | undefined;
            let settled = false;

            const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = undefined; };

            const armIdle = (onIdle: () => void) => {
                clearIdle();
                idleTimer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    this.logger.warn(
                        `Server antwortet seit ${Math.round(idleMs / 1000)}s nicht mehr – Anfrage abgebrochen.`
                    );
                    onIdle();
                }, idleMs);
            };

            // tool_calls kommen im Stream stückweise: der Name im ersten Chunk,
            // die Argumente über mehrere verteilt. Gesammelt wird nach dem
            // index-Feld, das die OpenAI-API pro Aufruf mitschickt.
            const toolAcc = new Map<number, { id?: string; name: string; args: string }>();

            const applyToolDeltas = (deltas: unknown) => {
                if (!Array.isArray(deltas)) return;
                for (const d of deltas) {
                    const item = d as {
                        index?: number; id?: string;
                        function?: { name?: string; arguments?: string };
                    };
                    const idx = item.index ?? 0;
                    const entry = toolAcc.get(idx) ?? { name: '', args: '' };
                    if (item.id) entry.id = item.id;
                    if (item.function?.name) entry.name += item.function.name;
                    if (item.function?.arguments) entry.args += item.function.arguments;
                    toolAcc.set(idx, entry);
                }
            };

            const collectedToolCalls = (): ToolCallResult[] | undefined => {
                if (toolAcc.size === 0) return undefined;
                const calls = [...toolAcc.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .filter(([, e]) => e.name)
                    .map(([, e]) => ({ id: e.id, name: e.name, arguments: e.args || '{}' }));
                return calls.length > 0 ? calls : undefined;
            };

            const req = lib.request(options, (res) => {
                res.setEncoding('utf-8');
                let buffer = '';

                // Ab jetzt zählt die Stille zwischen den Chunks
                armIdle(() => {
                    res.destroy();
                    req.destroy();
                    onStream('', true);
                    reject(new Error(
                        `Der Server hat ${Math.round(idleMs / 1000)}s lang nichts mehr gesendet. ` +
                        `Ist das Modell überlastet? (aiAssistant.streamIdleTimeoutSeconds erhöht die Wartezeit)`
                    ));
                });

                res.on('data', (chunk: string) => {
                    // Es kommt etwas – Uhr zurücksetzen
                    if (!settled) {
                        armIdle(() => {
                            res.destroy();
                            req.destroy();
                            onStream('', true);
                            reject(new Error(
                                `Der Server hat ${Math.round(idleMs / 1000)}s lang nichts mehr gesendet. ` +
                                `Ist das Modell überlastet? (aiAssistant.streamIdleTimeoutSeconds erhöht die Wartezeit)`
                            ));
                        });
                    }

                    if (this.abortFlag) {
                        res.destroy();
                        onStream('', true);
                        clearIdle(); if (!settled) { settled = true; resolve({ content: fullContent, finishReason: 'cancelled', toolCalls: collectedToolCalls() }); }
                        return;
                    }
                    buffer += chunk;
                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? '';

                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') {
                            onStream('', true);
                            clearIdle(); if (!settled) { settled = true; resolve({ content: fullContent, finishReason: toolAcc.size > 0 ? 'tool_calls' : 'stop', toolCalls: collectedToolCalls() }); }
                            return;
                        }
                        try {
                            const evt = JSON.parse(data);
                            const delta = evt.choices?.[0]?.delta ?? {};

                            // Werkzeugaufrufe sammeln (kommen über mehrere Chunks verteilt)
                            applyToolDeltas(delta.tool_calls);

                            // Kennzahlen weitergeben (llama.cpp liefert sie pro Chunk)
                            if (onStats && (evt.timings || evt.prompt_progress)) {
                                onStats(this.readStats(evt));
                            }

                            // DeepSeek R1: reasoning_content → als <think> Block streamen
                            const reasoning: string = delta.reasoning_content ?? '';
                            if (reasoning) {
                                // Öffnendes Tag einmalig einfügen
                                if (!fullContent.includes('<think>')) {
                                    fullContent += '<think>';
                                    onStream('<think>', false);
                                }
                                fullContent += reasoning;
                                onStream(reasoning, false);
                            }

                            const token: string = delta.content ?? '';
                            if (token) {
                                // Schließendes Tag einfügen wenn vorher reasoning kam
                                if (fullContent.includes('<think>') && !fullContent.includes('</think>')) {
                                    fullContent += '</think>';
                                    onStream('</think>', false);
                                }
                                fullContent += token;
                                onStream(token, false);
                            }
                        } catch {
                            // Ungültiges JSON-Fragment → überspringen
                        }
                    }
                });

                res.on('end', () => {
                    this.currentReq = null;
                    onStream('', true);
                    clearIdle(); if (!settled) { settled = true; resolve({ content: fullContent, finishReason: toolAcc.size > 0 ? 'tool_calls' : 'stop', toolCalls: collectedToolCalls() }); }
                });

                res.on('error', (err) => {
                    this.currentReq = null;
                    if (this.abortFlag) {
                        clearIdle(); if (!settled) { settled = true; resolve({ content: fullContent, finishReason: 'cancelled', toolCalls: collectedToolCalls() }); }
                    } else {
                        clearIdle(); if (!settled) { settled = true; reject(err); }
                    }
                });
            });

            this.currentReq = req;
            req.on('error', (err) => {
                this.currentReq = null;
                if (this.abortFlag) {
                    clearIdle(); if (!settled) { settled = true; resolve({ content: fullContent, finishReason: 'cancelled', toolCalls: collectedToolCalls() }); }
                } else {
                    clearIdle(); if (!settled) { settled = true; reject(err); }
                }
            });
            req.write(postData);
            req.end();
        });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // llama.cpp MCP-Protokoll (/mcp)
    // llama.cpp startet MCP-Server wenn mit --mcp-server Flag gestartet.
    // Kommunikation: JSON-RPC 2.0 über HTTP POST an /mcp
    // ──────────────────────────────────────────────────────────────────────────

    private async completeMCP(
        messages: ChatMessage[],
        options: CompletionOptions,
        onStream?: StreamCallback
    ): Promise<CompletionResult> {
        const baseUrl = this.getServerUrl();
        const mcpUrl = `${baseUrl}/mcp`;

        // JSON-RPC 2.0 Request
        const rpcRequest = {
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'sampling/createMessage',
            params: {
                messages: messages.map(m => ({
                    role: m.role,
                    content: { type: 'text', text: m.content }
                })),
                maxTokens: options.maxTokens ?? this.getMaxTokens(),
                temperature: options.temperature ?? this.getTemperature(),
                stopSequences: options.stopSequences ?? []
            }
        };

        this.logger.info(`→ MCP: ${mcpUrl}  (method: sampling/createMessage)`);

        try {
            const responseText = await this.httpPost(mcpUrl, rpcRequest);
            const parsed = JSON.parse(responseText);

            if (parsed.error) {
                throw new Error(`MCP Fehler: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
            }

            const result = parsed.result;
            const content: string =
                result?.content?.text ?? result?.message?.content?.text ?? '';

            if (onStream) {
                // Simuliertes Streaming für MCP (blockiert, dann alles auf einmal)
                onStream(content, false);
                onStream('', true);
            }

            return {
                content,
                finishReason: result?.stopReason ?? 'endTurn'
            };
        } catch (err) {
            // Fallback: MCP nicht erreichbar → OpenAI-API versuchen
            this.logger.warn(`MCP nicht erreichbar (${(err as Error).message}), Fallback auf OpenAI-API...`);
            return this.completeOpenAI(messages, options, onStream);
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // HTTP-Hilfsmethoden
    // ──────────────────────────────────────────────────────────────────────────

    private httpGet(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const lib = parsed.protocol === 'https:' ? https : http;

            lib.get(url, { timeout: 5000, headers: this.buildAuthHeaders() }, (res) => {
                let data = '';
                res.on('data', (d: Buffer) => { data += d.toString(); });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    } else {
                        resolve(data);
                    }
                });
                res.on('error', reject);
            }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
        });
    }

    private httpPost(
        url: string,
        body: Record<string, unknown>
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const isHttps = parsed.protocol === 'https:';
            const lib = isHttps ? https : http;

            const postData = JSON.stringify(body);
            const requestOptions: http.RequestOptions = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    ...this.buildAuthHeaders()
                },
                timeout: 120_000   // 2 Minuten für lange Completions
            };

            const req = lib.request(requestOptions, (res) => {
                let data = '';
                res.on('data', (d: Buffer) => { data += d.toString(); });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                    } else {
                        resolve(data);
                    }
                });
                res.on('error', reject);
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy(new Error('Request Timeout nach 120s'));
            });
            req.write(postData);
            req.end();
        });
    }
}
