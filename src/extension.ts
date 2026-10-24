import * as vscode from 'vscode';
import { findImageTags, getUnfilledImageTags, type ImageTag } from './imageTags.js';
import { generateAltText, type OllamaSettings } from './ollama.js';

const commandPrefix = 'ai-img-alt-text';
const generateCommand = `${commandPrefix}.generateAltText`;
const fillFileCommand = `${commandPrefix}.fillMissingAltText`;
const configureCommand = `${commandPrefix}.configureOllama`;
const supportedLanguages = ['html', 'javascriptreact', 'typescriptreact'];

export function activate(context: vscode.ExtensionContext): void {
	const selector = supportedLanguages.map((language) => ({ language, scheme: 'file' }));

	context.subscriptions.push(
		vscode.languages.registerHoverProvider(selector, {
			provideHover(document, position) {
				const offset = document.offsetAt(position);
				const tag = findImageTags(document.getText()).find((candidate) =>
					offset >= candidate.start &&
					offset < candidate.end &&
					candidate.source &&
					(candidate.alt === null || candidate.alt.trim() === ''),
				);
				if (!tag) {
					return undefined;
				}

				const args = encodeURIComponent(JSON.stringify([document.uri.toString(), tag.start]));
				const content = new vscode.MarkdownString(
					`[$(sparkle) Generate alt text](command:${generateCommand}?${args})`,
				);
				content.isTrusted = { enabledCommands: [generateCommand] };
				content.supportHtml = false;
				return new vscode.Hover(content, new vscode.Range(
					document.positionAt(tag.start),
					document.positionAt(tag.end),
				));
			},
		}),
		vscode.commands.registerCommand(generateCommand, async (uri: string, offset: number) => {
			try {
				const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
				const tag = findImageTags(document.getText()).find((candidate) => candidate.start === offset);
				if (!tag) {
					throw new Error('The image tag changed. Hover over it again and retry.');
				}
				if (!tag.source) {
					throw new Error('This image does not have a hard-coded src value.');
				}
				if (tag.alt !== null && tag.alt.trim() !== '') {
					throw new Error('This image already has alt text. Existing alt text was not changed.');
				}

				const settings = await getOllamaSettings();
				if (!settings) {
					return;
				}
				const source = tag.source;

				const editor = await getEditor(document);
				const version = document.version;
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Generating image alt text…', cancellable: true },
					async (_progress, token) => {
						const altText = await generateAltText(source, document.uri, settings, token);
						if (token.isCancellationRequested) {
							return;
						}
						if (document.version !== version) {
							throw new Error('The document changed while alt text was being generated. Please try again.');
						}
						const applied = await editor.edit((edit) => applyAltText(edit, document, tag, altText));
						if (!applied) {
							throw new Error('VS Code could not apply the generated alt text.');
						}
					},
				);
			} catch (error) {
				void vscode.window.showErrorMessage(`Could not generate alt text: ${errorMessage(error)}`);
			}
		}),
		vscode.commands.registerCommand(fillFileCommand, async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !supportedLanguages.includes(editor.document.languageId)) {
				void vscode.window.showErrorMessage('Open an HTML, JSX, or TSX file to fill image alt text.');
				return;
			}

			const document = editor.document;
			const targets = getUnfilledImageTags(document.getText());
			if (targets.length === 0) {
				void vscode.window.showInformationMessage('No images with missing or empty alt attributes were found.');
				return;
			}

			const confirmation = await vscode.window.showWarningMessage(
				`Generate alt text for ${targets.length} image${targets.length === 1 ? '' : 's'} with missing or empty alt attributes? Existing alt text will be left unchanged.`,
				{ modal: true },
				'Generate',
			);
			if (confirmation !== 'Generate') {
				return;
			}

			try {
				const settings = await getOllamaSettings();
				if (!settings) {
					return;
				}

				const version = document.version;
				const edits: Array<{ tag: ImageTag; altText: string }> = [];
				const failures: string[] = [];
				let cancelled = false;
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Filling image alt text',
						cancellable: true,
					},
					async (progress, token) => {
						for (let index = 0; index < targets.length; index++) {
							if (token.isCancellationRequested) {
								cancelled = true;
								break;
							}

							const tag = targets[index];
							progress.report({
								message: `Image ${index + 1} of ${targets.length}`,
								increment: 100 / targets.length,
							});
							if (!tag.source) {
								failures.push(`Image ${index + 1}: no hard-coded src value.`);
								continue;
							}

							try {
								const altText = await generateAltText(tag.source, document.uri, settings, token);
								if (token.isCancellationRequested) {
									cancelled = true;
									break;
								}
								edits.push({ tag, altText });
							} catch (error) {
								if (token.isCancellationRequested) {
									cancelled = true;
									break;
								}
								failures.push(`Image ${index + 1} (${tag.source}): ${errorMessage(error)}`);
							}
						}

						if (document.version !== version) {
							throw new Error('The document changed while alt text was being generated. No edits were applied.');
						}
						if (edits.length > 0) {
							const applied = await editor.edit((edit) => {
								for (const { tag, altText } of edits) {
									applyAltText(edit, document, tag, altText);
								}
							});
							if (!applied) {
								throw new Error('VS Code could not apply the generated alt text.');
							}
						}
					},
				);

				if (failures.length > 0) {
					const details = failures.slice(0, 3).join('\n');
					const remaining = failures.length > 3 ? `\n…and ${failures.length - 3} more.` : '';
					void vscode.window.showErrorMessage(
						`${edits.length} image${edits.length === 1 ? '' : 's'} updated; ${failures.length} failed.${cancelled ? ' Generation was cancelled.' : ''}\n${details}${remaining}`,
					);
				} else if (cancelled) {
					void vscode.window.showInformationMessage(
						`Generation cancelled. ${edits.length} image${edits.length === 1 ? '' : 's'} updated.`,
					);
				} else {
					void vscode.window.showInformationMessage(
						`Generated alt text for ${edits.length} image${edits.length === 1 ? '' : 's'}.`,
					);
				}
			} catch (error) {
				void vscode.window.showErrorMessage(`Could not fill image alt text: ${errorMessage(error)}`);
			}
		}),
		vscode.commands.registerCommand(configureCommand, async () => {
			try {
				await getOllamaSettings(true);
			} catch (error) {
				void vscode.window.showErrorMessage(`Could not configure Ollama: ${errorMessage(error)}`);
			}
		}),
	);
}

async function getOllamaSettings(forcePrompt = false): Promise<OllamaSettings | undefined> {
	const configuration = vscode.workspace.getConfiguration(commandPrefix);
	let url = configuration.get<string>('ollamaUrl', '').trim();
	let model = configuration.get<string>('model', '').trim();

	if (forcePrompt || !url || validateOllamaUrl(url)) {
		const input = await vscode.window.showInputBox({
			title: 'Ollama server URL',
			prompt: 'Enter the URL of your local Ollama server.',
			placeHolder: 'http://localhost:11434',
			value: url || 'http://localhost:11434',
			validateInput: validateOllamaUrl,
			ignoreFocusOut: true,
		});
		if (input === undefined) {
			return undefined;
		}
		url = normalizeOllamaUrl(input);
	}

	if (forcePrompt || !model) {
		const input = await vscode.window.showInputBox({
			title: 'Ollama vision model',
			prompt: 'Enter an installed vision model name, such as gemma3:latest.',
			placeHolder: 'gemma3:latest',
			value: model || 'gemma3:latest',
			validateInput: (value) => value.trim() ? undefined : 'Enter an Ollama model name.',
			ignoreFocusOut: true,
		});
		if (input === undefined) {
			return undefined;
		}
		model = input.trim();
	}

	await configuration.update('ollamaUrl', url, vscode.ConfigurationTarget.Global);
	await configuration.update('model', model, vscode.ConfigurationTarget.Global);
	return { url, model };
}

function validateOllamaUrl(value: string): string | undefined {
	try {
		normalizeOllamaUrl(value);
		return undefined;
	} catch (error) {
		return errorMessage(error);
	}
}

function normalizeOllamaUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error('Enter a valid server URL, such as http://localhost:11434.');
	}
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new Error('The server URL must use HTTP or HTTPS and must not contain credentials.');
	}
	if (url.search || url.hash) {
		throw new Error('The server URL must not include a query string or fragment.');
	}
	return url.toString().replace(/\/+$/, '');
}

async function getEditor(document: vscode.TextDocument): Promise<vscode.TextEditor> {
	const editor = vscode.window.visibleTextEditors.find((candidate) =>
		candidate.document.uri.toString() === document.uri.toString(),
	);
	return editor ?? vscode.window.showTextDocument(document);
}

function applyAltText(
	edit: vscode.TextEditorEdit,
	document: vscode.TextDocument,
	tag: ImageTag,
	altText: string,
): void {
	const escapedAltText = escapeAttribute(altText);
	if (tag.altStart !== null && tag.altEnd !== null) {
		edit.replace(
			new vscode.Range(document.positionAt(tag.altStart), document.positionAt(tag.altEnd)),
			escapedAltText,
		);
		return;
	}

	const text = document.getText();
	let insertionOffset = tag.end - 1;
	while (insertionOffset > tag.start && /\s/.test(text[insertionOffset - 1])) {
		insertionOffset--;
	}
	const isSelfClosing = text[insertionOffset - 1] === '/';
	if (isSelfClosing) {
		insertionOffset--;
		while (insertionOffset > tag.start && /\s/.test(text[insertionOffset - 1])) {
			insertionOffset--;
		}
	}
	const suffix = isSelfClosing ? ' ' : '';
	edit.insert(document.positionAt(insertionOffset), ` alt="${escapedAltText}"${suffix}`);
}

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function deactivate(): void {}
