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
}

export interface CompletionResult {
    content: string;
    tokenCount?: number;
    finishReason?: string;
}

// Callback-Typ für Streaming-Tokens
export type StreamCallback = (token: string, done: boolean) => void;

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
     * Verbindung zum llama.cpp Server testen.
     * Gibt Model-Infos zurück oder wirft einen Fehler.
     */
    async testConnection(): Promise<{ success: boolean; info: string }> {
        const baseUrl = this.getServerUrl();
        try {
            // llama.cpp health-Endpunkt prüfen
            const health = await this.httpGet(`${baseUrl}/health`);
            const healthObj = JSON.parse(health);

            // Verfügbare Modelle abfragen
            let modelInfo = '';
            try {
                const models = await this.httpGet(`${baseUrl}/v1/models`);
                const modelsObj = JSON.parse(models);
                if (modelsObj.data?.length > 0) {
                    modelInfo = ` | Modelle: ${modelsObj.data.map((m: { id: string }) => m.id).join(', ')}`;
                }
            } catch {
                // /v1/models optional
            }

            return {
                success: true,
                info: `Status: ${healthObj.status ?? 'ok'}${modelInfo}`
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, info: msg };
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
        if (this.isMCPEnabled()) {
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

        this.logger.info(`→ OpenAI API: ${url}  (stream=${stream})`);

        if (stream && onStream) {
            return this.streamOpenAI(url, body, onStream);
        }

        const responseText = await this.httpPost(url, body);
        const parsed = JSON.parse(responseText);

        const content: string =
            parsed.choices?.[0]?.message?.content ?? '';
        const tokenCount: number =
            parsed.usage?.completion_tokens;
        const finishReason: string =
            parsed.choices?.[0]?.finish_reason ?? 'unknown';

        return { content, tokenCount, finishReason };
    }

    /** Server-Sent-Events Streaming für /v1/chat/completions */
    private streamOpenAI(
        url: string,
        body: Record<string, unknown>,
        onStream: StreamCallback
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
                    'Accept': 'text/event-stream'
                }
            };

            this.abortFlag = false;
            let fullContent = '';

            const req = lib.request(options, (res) => {
                res.setEncoding('utf-8');
                let buffer = '';

                res.on('data', (chunk: string) => {
                    if (this.abortFlag) {
                        res.destroy();
                        onStream('', true);
                        resolve({ content: fullContent, finishReason: 'cancelled' });
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
                            resolve({ content: fullContent, finishReason: 'stop' });
                            return;
                        }
                        try {
                            const evt = JSON.parse(data);
                            const token: string =
                                evt.choices?.[0]?.delta?.content ?? '';
                            if (token) {
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
                    resolve({ content: fullContent, finishReason: 'stop' });
                });

                res.on('error', (err) => {
                    this.currentReq = null;
                    if (this.abortFlag) {
                        resolve({ content: fullContent, finishReason: 'cancelled' });
                    } else {
                        reject(err);
                    }
                });
            });

            this.currentReq = req;
            req.on('error', (err) => {
                this.currentReq = null;
                if (this.abortFlag) {
                    resolve({ content: fullContent, finishReason: 'cancelled' });
                } else {
                    reject(err);
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

            lib.get(url, { timeout: 5000 }, (res) => {
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
                    'Content-Length': Buffer.byteLength(postData)
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
