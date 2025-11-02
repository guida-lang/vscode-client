import * as vscode from 'vscode';
import * as assert from 'assert';
import { getDocUri, activate } from './helper';

suite('Should get diagnostics', () => {
	const docUri = getDocUri('src/Diagnostics.guida');

	test('Diagnoses missing implementation', async () => {
		await testDiagnostics(docUri, [
			{
				message: 'I am trying to parse a declaration, but I am getting stuck here:\n' +
					'\n' +
					'3| missingImplementation =\n' +
					'   ^\n' +
					'When a line has no spaces at the beginning, I expect it to be a declaration like\n' +
					'one of these:\n' +
					'\n' +
					'    greet : String -> String\n' +
					'    greet name =\n' +
					'      "Hello " ++ name ++ "!"\n' +
					'    \n' +
					'    type User = Anonymous | LoggedIn String\n' +
					'\n' +
					'Try to make your declaration look like one of those? Or if this is not supposed\n' +
					'to be a declaration, try adding some spaces before it?',
				range: toRange(2, 0, 2, 0),
				severity: vscode.DiagnosticSeverity.Error,
				source: 'guida'
			}
		]);
	});
});

function toRange(sLine: number, sChar: number, eLine: number, eChar: number) {
	const start = new vscode.Position(sLine, sChar);
	const end = new vscode.Position(eLine, eChar);
	return new vscode.Range(start, end);
}

async function testDiagnostics(docUri: vscode.Uri, expectedDiagnostics: vscode.Diagnostic[]) {
	await activate(docUri);

	const actualDiagnostics = vscode.languages.getDiagnostics(docUri);
	console.log('Actual diagnostics: ', actualDiagnostics[0].range);

	assert.equal(actualDiagnostics.length, expectedDiagnostics.length);

	expectedDiagnostics.forEach((expectedDiagnostic, i) => {
		const actualDiagnostic = actualDiagnostics[i];
		assert.equal(actualDiagnostic.message, expectedDiagnostic.message);
		assert.deepEqual(actualDiagnostic.range, expectedDiagnostic.range);
		assert.equal(actualDiagnostic.severity, expectedDiagnostic.severity);
	});
}