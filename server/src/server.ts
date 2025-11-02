import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    DocumentDiagnosticReportKind,
    type DocumentDiagnosticReport
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

// @ts-expect-error missing type
import { XMLHttpRequest } from 'xmlhttprequest';

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as guida from "guida";

const config = (textDocument: TextDocument): guida.GuidaConfig => {
    return {
        XMLHttpRequest,
        env: {
            GUIDA_REGISTRY: "https://guida-package-registry.fly.dev"
        },
        writeFile: async (path: string, data: string) => {
            fs.writeFileSync(path, data);
        },
        readFile: async (path: string) => {
            const uri = URI.file(path);
            const document = documents.get(uri.toString());

            if (document) {
                return document.getText();
            }

            return await fs.readFileSync(path);
        },
        details: (path: string) => {
            const stats = fs.statSync(path);

            return Promise.resolve({
                type: stats.isFile() ? "file" : "directory",
                createdAt: Math.trunc(stats.birthtimeMs)
            });
        },
        createDirectory: (path: string) => {
            return new Promise((resolve, _reject) => {
                fs.mkdir(path, (_err) => {
                    resolve();
                });
            });
        },
        readDirectory: (path: string) => {
            return new Promise((resolve, _reject) => {
                fs.readdir(path, { recursive: false }, (err, files) => {
                    if (err) { throw err; }
                    resolve({ files });
                });
            });
        },
        getCurrentDirectory: () => {
            const uri: URI = URI.parse(textDocument.uri);
            return Promise.resolve(path.dirname(uri.fsPath));
        },
        homedir: () => {
            return Promise.resolve(os.homedir());
        }
    };
};

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );
    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
    );

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            // Tell the client that this server supports code completion.
            completionProvider: {
                resolveProvider: true
            },
            diagnosticProvider: {
                interFileDependencies: false,
                workspaceDiagnostics: false
            },
            documentFormattingProvider: true
        }
    };

    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }

    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }
});

// The guida settings
interface GuidaSettings {
    maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
const defaultSettings: GuidaSettings = { maxNumberOfProblems: 1000 };
let globalSettings: GuidaSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings = new Map<string, Thenable<GuidaSettings>>();

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    } else {
        globalSettings = (
            (change.settings.guidaLanguageServer || defaultSettings)
        );
    }
    // Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
    // We could optimize things here and re-fetch the setting first can compare it
    // to the existing setting, but this is out of scope for this example.
    connection.languages.diagnostics.refresh();
});

function getDocumentSettings(resource: string): Thenable<GuidaSettings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'guidaLanguageServer'
        });
        documentSettings.set(resource, result);
    }
    return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
    documentSettings.delete(e.document.uri);
});

connection.languages.diagnostics.on(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (document !== undefined) {
        return {
            kind: DocumentDiagnosticReportKind.Full,
            items: await validateTextDocument(document)
        } satisfies DocumentDiagnosticReport;
    } else {
        // We don't know the document. We can either try to read it from disk
        // or we don't report problems for it.
        return {
            kind: DocumentDiagnosticReportKind.Full,
            items: []
        } satisfies DocumentDiagnosticReport;
    }
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<Diagnostic[]> {
    // In this simple example we get the settings for every validate run.
    const settings = await getDocumentSettings(textDocument.uri);

    // The validator creates diagnostics for all uppercase words length 2 and more
    const text = textDocument.getText();

    // If the document is empty, skip parsing and return no diagnostics
    if (!text) { return []; }

    const uri: URI = URI.parse(textDocument.uri);

    const options = uri.scheme === "file" ? { path: uri.fsPath } : { content: text };

    const result: guida.DiagnosticsResult = await guida.diagnostics(config(textDocument), options);

    if (!result) {
        return [];
    } else if (result.type === "content-error") {
        return [{
            severity: DiagnosticSeverity.Error,
            range: {
                start: {
                    line: result.error.region.start.line - 1,
                    character: result.error.region.start.column - 1
                },
                end: {
                    line: result.error.region.end.line - 1,
                    character: result.error.region.end.column - 1
                }
            },
            message: result.error.message.map((m) => { return typeof m === "string" ? m : m.string; }).join(""),
            source: 'guida'
        }];
    } else if (result.type === "compile-errors") {
        return result.errors.flatMap((err) => {
            return err.problems.map((problem) => {
                return {
                    severity: DiagnosticSeverity.Error,
                    range: {
                        start: {
                            line: problem.region.start.line - 1,
                            character: problem.region.start.column - 1
                        },
                        end: {
                            line: problem.region.end.line - 1,
                            character: problem.region.end.column - 1
                        }
                    },
                    message: problem.message.map((m) => { return typeof m === "string" ? m : m.string; }).join(""),
                    source: 'guida'
                };
            });
        });
    } else {
        return [];
    }
}

connection.onDidChangeWatchedFiles(_change => {
    // Monitored files have change in VSCode
    connection.console.log('We received a file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
    (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
        // The pass parameter contains the position of the text document in
        // which code complete got requested. For the example we ignore this
        // info and always provide the same completion items.
        return [
            {
                label: 'if',
                kind: CompletionItemKind.Keyword,
                data: 1
            },
            {
                label: 'then',
                kind: CompletionItemKind.Keyword,
                data: 2
            },
            {
                label: 'then',
                kind: CompletionItemKind.Keyword,
                data: 3
            },
            {
                label: 'else',
                kind: CompletionItemKind.Keyword,
                data: 4
            },
            {
                label: 'case',
                kind: CompletionItemKind.Keyword,
                data: 5
            },
            {
                label: 'of',
                kind: CompletionItemKind.Keyword,
                data: 6
            },
            {
                label: 'let',
                kind: CompletionItemKind.Keyword,
                data: 7
            },
            {
                label: 'in',
                kind: CompletionItemKind.Keyword,
                data: 8
            },
            {
                label: 'type',
                kind: CompletionItemKind.Keyword,
                data: 9
            },
            {
                label: 'module',
                kind: CompletionItemKind.Keyword,
                data: 10
            },
            {
                label: 'where',
                kind: CompletionItemKind.Keyword,
                data: 11
            },
            {
                label: 'import',
                kind: CompletionItemKind.Keyword,
                data: 12
            },
            {
                label: 'exposing',
                kind: CompletionItemKind.Keyword,
                data: 13
            },
            {
                label: 'as',
                kind: CompletionItemKind.Keyword,
                data: 14
            },
            {
                label: 'port',
                kind: CompletionItemKind.Keyword,
                data: 15
            }
        ];
    }
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
    (item: CompletionItem): CompletionItem => {
        if (item.data === 1) {
            item.detail = 'if keyword';
            item.documentation = 'If statement documentation';
        } else if (item.data === 2) {
            item.detail = 'then keyword';
            item.documentation = 'Then statement documentation';
        }
        return item;
    }
);

connection.onDocumentFormatting(async (params) => {
    const { textDocument } = params;

    // Get document text from document manager
    const document = documents.get(textDocument.uri);

    if (!document) {
        return;
    }

    const text = document.getText();

    const result = await guida.format(config(document), text);

    if (result.output) {
        return [
            {
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: document.lineCount, character: 0 },
                },
                newText: result.output,
            }
        ];
    } else {
        throw new Error("Formatting failed: " + result.error);
    }
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();